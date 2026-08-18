/**
 * OpenCode Zen 免费模型的无认证 LLM 适配器：注册为名为「OpenCode Free」的
 * provider（路由 `opencode-free`），自动提供 /models 里所有 `*-free` 模型。
 * 免费模型要求**不携带 Authorization 头**（带无效 key 会 401），按 IP 限流、
 * 非零保留（数据可能用于改进模型）。非流式调用：整段返回后按块发射。
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import {
  LlmAdapter, LlmError, attributionHeaders,
  type ContentBlock, type FinishReason, type GenerateOptions,
  type LlmModelInfo, type LlmResolvedModelInfo, type Message,
  type StreamChunk, type TokenUsage,
} from "@deepseek-ai/dsh-llm";

export const name = "dsh-config-opencode";
export const inject = ["llm"];

const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1/chat/completions";
const DEFAULT_MODELS_URL = "https://opencode.ai/zen/v1/models";
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const FREE_SUFFIX = "-free";

export interface Config {
  /** chat completions 端点。 */
  baseUrl?: string
  /** 模型列表端点（用于自动发现 `*-free` 模型）。 */
  modelsUrl?: string
  /** 未在列表中的模型使用的上下文容量。 */
  contextWindow?: number
  /** 固定模型清单；为空时启动时从 modelsUrl 拉取并过滤 `*-free`。 */
  models?: string[]
  /** 每请求默认输出上限。 */
  maxTokens?: number
}

export const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  modelsUrl: z.string().default(DEFAULT_MODELS_URL),
  contextWindow: z.number().default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(z.string()).default([]),
  maxTokens: z.number().default(8192),
});

interface OpenAiMessage {
  role: string;
  content: string;
}

interface OpenAiResponse {
  choices?: { index?: number; finish_reason?: string | null; message?: { content?: string | null; reasoning_content?: string | null } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; reasoning_tokens?: number }
  error?: { message?: string; type?: string }
}

interface ModelList {
  data?: { id?: string }[]
}

/** 从 harness Message 提取纯文本块（图片/工具结果等非文本块不发送）。 */
function textContent(message: Message): string {
  const parts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") parts.push(part.text);
  }
  return parts.join("\n");
}

function serializeMessages(system: string | undefined, messages: readonly Message[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  if (system !== undefined && system.length > 0) out.push({ role: "system", content: system });
  for (const message of messages) {
    out.push({ role: message.role === "assistant" ? "assistant" : "user", content: textContent(message) });
  }
  return out;
}

function mapFinishReason(reason: string | null | undefined): FinishReason {
  return reason === "length" ? { kind: "max-tokens" } : { kind: "stop" };
}

class OpenCodeAdapter extends LlmAdapter {
  constructor(private readonly config: Config) {
    super();
  }

  providerInfo(provider: string) {
    return { id: provider, name: "OpenCode Free" };
  }

  /** 配置清单 + 实时拉取 /models 过滤 `*-free`。 */
  async listModels(provider: string): Promise<LlmModelInfo[]> {
    const ids = new Set(this.config.models ?? []);
    try {
      const response = await fetch(this.config.modelsUrl ?? DEFAULT_MODELS_URL, { headers: attributionHeaders() });
      if (response.ok) {
        const parsed = await response.json() as ModelList;
        for (const item of parsed.data ?? []) {
          if (item.id !== undefined && item.id.endsWith(FREE_SUFFIX)) ids.add(item.id);
        }
      }
    } catch {
      // 拉取失败时退回配置清单；适配器允许调用未列出的模型 id。
    }
    return Array.from(ids).map((id) => ({ provider, id, name: id }));
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.config.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
      ...this.config.maxTokens !== undefined ? { defaultMaxTokens: this.config.maxTokens } : {},
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: serializeMessages(options.system, options.messages),
      stream: false,
      max_tokens: options.maxTokens ?? this.config.maxTokens ?? 8192,
    };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.stop !== undefined && options.stop.length > 0) body.stop = options.stop;

    let response: Response;
    try {
      response = await fetch(this.config.baseUrl ?? DEFAULT_BASE_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "application/json", ...attributionHeaders() },
        body: JSON.stringify(body),
        signal: options.signal ?? null,
      });
    } catch (error: unknown) {
      if (options.signal?.aborted) {
        throw new LlmError("opencode request aborted by caller", "ABORTED", { cause: error });
      }
      throw new LlmError("opencode API request failed", "TRANSPORT", { cause: error });
    }

    if (!response.ok) {
      let message = `opencode API error (HTTP ${response.status})`;
      try {
        const parsed = await response.json() as OpenAiResponse;
        if (parsed.error?.message !== undefined) message = parsed.error.message;
      } catch {
        // 错误体解析失败时保留状态码信息。
      }
      throw new LlmError(message, response.status === 429 ? "RATE_LIMIT" : "TRANSPORT", { status: response.status });
    }

    const parsed = await response.json() as OpenAiResponse;
    const choice = parsed.choices?.[0];
    const reasoning = choice?.message?.reasoning_content ?? undefined;
    const content = choice?.message?.content ?? undefined;

    if (reasoning !== undefined && reasoning.length > 0) {
      yield { type: "block-start", index: 0, blockType: "reasoning" };
      yield { type: "reasoning-delta", index: 0, text: reasoning };
      yield { type: "block-end", index: 0, block: { type: "reasoning", text: reasoning } };
    }
    const textIndex = reasoning !== undefined && reasoning.length > 0 ? 1 : 0;
    if (content !== undefined && content.length > 0) {
      yield { type: "block-start", index: textIndex, blockType: "text" };
      yield { type: "text-delta", index: textIndex, text: content };
      yield { type: "block-end", index: textIndex, block: { type: "text", text: content } };
    }

    const usage: TokenUsage = {
      inputTokens: parsed.usage?.prompt_tokens ?? 0,
      outputTokens: parsed.usage?.completion_tokens ?? 0,
      ...parsed.usage?.reasoning_tokens !== undefined ? { reasoningTokens: parsed.usage.reasoning_tokens } : {},
    };
    yield { type: "usage", usage };
    yield { type: "finish", reason: mapFinishReason(choice?.finish_reason), replayState: { model: options.model } };
  }
}

/** 注册「OpenCode Free」provider（路由 opencode-free），自动提供 *-free 模型。 */
export function apply(ctx: Context, config: Config): void {
  ctx.llm.registerAdapter(["opencode-free"], new OpenCodeAdapter(config));
}
