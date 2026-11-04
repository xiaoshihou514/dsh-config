/**
 * 让 Agent Teams 的组长招人时能按成员指定模型。
 *
 * 实验插件 `dsh-experimental-tool-agent-team` 的 `spawn_teammate` 只有 name / description /
 * prompt / context，运行时调用 `subagents.startActivation` 时也不传 `agentOptions`，所以队友
 * 一律继承组长当时的模型。底层子智能体服务其实支持 `agentOptions`（spawn / fork 后端都声明了
 * 这项能力），并把选中的模型写进子会话的描述符，续跑时恢复。本插件补上中间这一段：
 *
 *  1. 同名工具在同一作用域不能重复注册，所以把已注册的 `spawn_teammate` 定义原地补上
 *     `provider` / `model` / `reasoning_effort` 三个参数和说明（模型看到的工具表每轮现算，
 *     参数校验不拒绝多余字段，原工具体忽略它们）；
 *  2. `tools/execute` 包一层：带了模型参数就按「子智能体可选模型」设置
 *     （`subagent-model-selection-settings` 的 `allowedModels`）校验并预检线路，登记待领取；
 *  3. 包一层 `subagents.startActivation`：同一组长、同一职责描述、且没带 `agentOptions` 的
 *     创建请求领走登记的模型。
 *
 * 不传模型参数时行为与原版完全一致。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

export const name = "dsh-config-team-model";
export const inject = ["agents", "tools"];

export interface Config {}
export const Config = z.object({});

const TOOL = "spawn_teammate";

export interface Route {
  readonly provider: string;
  readonly model: string;
}

export interface ModelChoice extends Route {
  readonly reasoningEffort?: string;
}

/** 从工具参数里取出模型选择；都没给返回 undefined，给得不完整或不在名单里抛错。 */
export function parseChoice(
  args: Record<string, unknown>,
  allowed: readonly Route[] | undefined,
): ModelChoice | undefined {
  const text = (key: string): string | undefined => {
    const value = args[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new Error(`\`${key}\` must be a string`);
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  };
  const provider = text("provider");
  const model = text("model");
  const reasoningEffort = text("reasoning_effort");
  if (provider === undefined && model === undefined && reasoningEffort === undefined) return undefined;
  if (provider === undefined || model === undefined)
    throw new Error("teammate `provider` and `model` must be supplied together (`reasoning_effort` also needs them)");
  if (allowed === undefined || allowed.length === 0)
    throw new Error("teammate model selection is disabled: no subagent models are allowed in settings");
  if (!allowed.some((route) => route.provider === provider && route.model === model))
    throw new Error(
      `teammate model "${provider}/${model}" is not allowed; allowed: ${allowed.map((r) => `${r.provider}/${r.model}`).join(", ")}`,
    );
  return reasoningEffort === undefined ? { provider, model } : { provider, model, reasoningEffort };
}

/** 工具说明里追加的一段（名单现读，设置改了下一轮就变）。 */
export function choiceGuidance(allowed: readonly Route[] | undefined): string {
  if (allowed === undefined || allowed.length === 0) return "";
  return (
    " Optional `provider` + `model` (with optional `reasoning_effort`) pick this teammate's LLM;" +
    " omit them to inherit your current model. The choice is fixed for the teammate's lifetime." +
    ` Allowed provider/model routes: ${allowed.map((r) => `${r.provider} / ${r.model}`).join("; ")}.`
  );
}

interface MutableDefinition {
  description: string;
  parameters: { properties?: Record<string, unknown> };
}

const PARAMS: Record<string, unknown> = {
  provider: {
    type: "string",
    description: "LLM provider id for the teammate (see Allowed routes). Supply together with model; omit both to inherit the Lead's model.",
  },
  model: {
    type: "string",
    description: "Model id interpreted by provider. Supply together with provider.",
  },
  reasoning_effort: {
    type: "string",
    description: "Reasoning effort for the chosen model. Omit to use that model's default.",
  },
};

const patched = new WeakSet<object>();

/** 给一份 spawn_teammate 定义补参数与说明（幂等）。 */
export function patchDefinition(def: MutableDefinition, guidance: () => string): void {
  if (patched.has(def)) return;
  const properties = def.parameters.properties;
  if (properties === undefined) return;
  for (const [key, schema] of Object.entries(PARAMS)) if (!(key in properties)) properties[key] = schema;
  const base = def.description;
  Object.defineProperty(def, "description", {
    configurable: true,
    enumerable: true,
    get: () => base + guidance(),
  });
  patched.add(def);
}

interface StartSpec {
  readonly provider: string;
  readonly label?: string;
  readonly request: {
    readonly parent: { readonly id: string };
    readonly agentOptions?: Record<string, unknown>;
  } & Record<string, unknown>;
}

interface Pending {
  readonly label: string;
  readonly choice: ModelChoice;
}

/** 按组长会话 id 登记、由 startActivation 领取的模型选择。 */
export class PendingChoices {
  private readonly byParent = new Map<string, Pending[]>();

  add(parentId: string, label: string, choice: ModelChoice): () => void {
    const entry: Pending = { label: label.trim(), choice };
    const list = this.byParent.get(parentId) ?? [];
    list.push(entry);
    this.byParent.set(parentId, list);
    return () => this.remove(parentId, entry);
  }

  /** 给创建请求补上 agentOptions；没有匹配的登记原样返回。 */
  apply<T extends StartSpec>(spec: T): T {
    if (spec.request.agentOptions !== undefined) return spec;
    const list = this.byParent.get(spec.request.parent.id);
    const label = spec.label?.trim();
    const entry = list?.find((candidate) => candidate.label === label);
    if (entry === undefined) return spec;
    this.remove(spec.request.parent.id, entry);
    const { provider, model, reasoningEffort } = entry.choice;
    return {
      ...spec,
      request: {
        ...spec.request,
        agentOptions: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) },
      },
    };
  }

  private remove(parentId: string, entry: Pending): void {
    const list = this.byParent.get(parentId);
    if (list === undefined) return;
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) this.byParent.delete(parentId);
  }
}

interface SelectionService {
  current(): { enabled: boolean; allowedModels: Route[] };
}

interface LlmService {
  resolveCallConfig(
    options: { provider: string; model: string; reasoningEffort?: string },
    signal?: AbortSignal,
  ): Promise<unknown>;
}

interface SubagentsService {
  startActivation(spec: StartSpec): Promise<unknown>;
}

export function apply(ctx: Context): void {
  const pending = new PendingChoices();

  const allowedRoutes = (): Route[] | undefined => {
    const service = ctx.get("subagentModelSelection" as never) as SelectionService | undefined;
    if (service === undefined) return undefined;
    try {
      const current = service.current();
      return current.enabled ? current.allowedModels : undefined;
    } catch (error) {
      ctx.logger.warn(`team-model: cannot read subagent model selection: ${String(error)}`);
      return undefined;
    }
  };
  const guidance = () => choiceGuidance(allowedRoutes());

  // ---- 1. 给每个组长的 spawn_teammate 补参数
  const patchAll = () => {
    for (const agent of ctx.agents.list()) {
      const def = ctx.tools.get(TOOL, agent) as unknown as MutableDefinition | undefined;
      if (def !== undefined) patchDefinition(def, guidance);
    }
  };
  patchAll();
  ctx.on("tools/change", patchAll);
  ctx.on("agent/created", () => {
    setImmediate(patchAll);
  });

  // ---- 2. 包一层 subagents.startActivation（服务对象是代理，改原型上的方法）
  let restore: (() => void) | undefined;
  const ensureSubagentsPatched = () => {
    if (restore !== undefined) return;
    const service = ctx.get("subagents" as never) as SubagentsService | undefined;
    if (service === undefined) return;
    const proto = Object.getPrototypeOf(service) as SubagentsService;
    const original = proto.startActivation;
    if (typeof original !== "function") return;
    const wrapped = function (this: SubagentsService, spec: StartSpec) {
      return original.call(this, pending.apply(spec));
    };
    proto.startActivation = wrapped;
    restore = () => {
      if (proto.startActivation === wrapped) proto.startActivation = original;
    };
  };
  ctx.effect(() => () => {
    restore?.();
    restore = undefined;
  }, "team-model.startActivation()");

  // ---- 3. 招人调用：校验、预检、登记
  ctx.on("tools/execute", async (exec, next) => {
    if (exec.name !== TOOL || exec.agent === undefined) return next();
    const args = (exec.arguments ?? {}) as Record<string, unknown>;
    const choice = parseChoice(args, allowedRoutes());
    if (choice === undefined) return next();
    const description = typeof args.description === "string" ? args.description : "";
    const llm = ((exec.agent as Agent).ctx.get("llm" as never) ?? ctx.get("llm" as never)) as LlmService | undefined;
    await llm?.resolveCallConfig(
      {
        provider: choice.provider,
        model: choice.model,
        ...(choice.reasoningEffort === undefined ? {} : { reasoningEffort: choice.reasoningEffort }),
      },
      exec.signal,
    );
    ensureSubagentsPatched();
    if (restore === undefined) throw new Error("teammate model selection is unavailable: subagents service not found");
    const release = pending.add((exec.agent as Agent).id, description, choice);
    try {
      return await next();
    } finally {
      release();
    }
  });
}
