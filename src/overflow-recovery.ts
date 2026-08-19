/**
 * CONTEXT_WINDOW_EXCEEDED 自动压缩兜底恢复。
 *
 * harness 的 compaction-basic 已内置「请求失败代码为 CONTEXT_WINDOW_EXCEEDED
 * 时自动压缩并重试」（agent/request-error → compactIfNeeded("context-overflow")
 * → { kind: "retry" }，默认 maxOverflowRetries=1）。本插件只做两件事：
 *
 *  1. 内置恢复监听器注册在预设 realm（比宿主层更内层），而 cordis waterfall
 *     从最外层向最内层执行——本监听器在宿主层注册（最外层），必须转发
 *     `next()` 让内置恢复先处理，绝不遮蔽内置行为；
 *  2. 内置恢复放弃时（未触发、compactIfNeeded 返回 null、或重试次数用尽），
 *     通过 `agent.ctx` 解析到 realm 内的 compaction 引擎补一次压缩重试
 *     （默认 1 次，可配置），仍失败则保持原错误语义。
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { CONTEXT_WINDOW_EXCEEDED_CODE } from "@deepseek-ai/dsh-llm";
import type { Agent, RequestErrorAction } from "@deepseek-ai/dsh-agent";
import type { CompactionEngine } from "@deepseek-ai/dsh-compaction";

export const name = "dsh-config-overflow-recovery";

export interface Config {
  /** 内置恢复放弃后，本插件额外补的压缩重试次数（默认 1）。 */
  maxOverflowCompactions?: number
}

export const Config = z.object({
  maxOverflowCompactions: z.number().default(1),
});

export function apply(ctx: Context, config: Config): void {
  const maxOverflowCompactions = config.maxOverflowCompactions ?? 1;
  /** 每个 agent 已由本插件触发的压缩重试次数；idle 时清空。 */
  const usedRetries = new WeakMap<Agent, number>();

  ctx.on("agent/request-error", async ({ agent, failure, signal }, next): Promise<RequestErrorAction> => {
    if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next();

    // 先让内置恢复（compaction-basic，位于更内层作用域）处理；其返回值就是
    // 链条结果（本监听器是最外层，必须原样透传）。
    let action: RequestErrorAction;
    try {
      action = await next();
    } catch (error) {
      // 内层监听器异常：不吞掉恢复机会，继续尝试自己的兜底。
      ctx.logger.warn(`overflow recovery: built-in handler threw: ${error instanceof Error ? error.message : String(error)}`);
      action = undefined;
    }
    if (action !== undefined) return action;

    // 内置恢复未接管（未注册 / 放弃 / 重试次数用尽）：自己补一次压缩重试。
    const used = usedRetries.get(agent) ?? 0;
    if (used >= maxOverflowCompactions) return undefined;
    const engine: CompactionEngine | undefined = agent.ctx.compaction;
    if (engine === undefined) return undefined; // 作用域内没有压缩引擎，无法恢复
    try {
      const result = await engine.compactIfNeeded(agent, "context-overflow", signal);
      if (signal.aborted) return undefined;
      if (result === null) return undefined; // 没有可压缩范围，保持原错误
      usedRetries.set(agent, used + 1);
      ctx.logger.info(`overflow recovery: compacted ${result.shadowedSeqs.length} surface nodes; retrying request`);
      return { kind: "retry" };
    } catch (error) {
      ctx.logger.warn(`overflow recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  });

  ctx.on("agent/status", ({ agent, status }) => {
    if (status === "idle") usedRetries.delete(agent);
  });
}
