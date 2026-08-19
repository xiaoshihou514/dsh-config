/**
 * OpenCode Zen 免费模型的无认证 LLM 适配器：注册为名为「OpenCode Free」的
 * provider（路由 `opencode-free`），自动提供 /models 里所有 `*-free` 模型。
 * 免费模型要求**不携带 Authorization 头**（带无效 key 会 401），按 IP 限流、
 * 非零保留（数据可能用于改进模型）。非流式调用：整段返回后按块发射。
 * 推理等级与原生 DeepSeek 适配器共用 off/high/max 词汇表：resolveModel
 * 声明 efforts 让原生选择器出现，stream 把生效等级映射到 wire 参数
 * （high/max → reasoning_effort；off → thinking disabled）。
 * 错误归类与原生适配器一致：400 + 上下文超限 → CONTEXT_WINDOW_EXCEEDED，
 * 由 harness 内置压缩恢复（+ dsh-config overflow-recovery 兜底）自动压缩重试。
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  attributionHeaders,
  isContextWindowExceededError,
  isQuotaExceededError,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmReasoningEffortInfo,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
  type TokenUsage,
} from "@deepseek-ai/dsh-llm";

export const name = "dsh-config-opencode";
export const inject = ["llm"];

const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1/chat/completions";
const DEFAULT_MODELS_URL = "https://opencode.ai/zen/v1/models";
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const DEFAULT_MODEL = "deepseek-v4-flash-free";
const FREE_SUFFIX = "-free";
const MODELS_FETCH_TIMEOUT_MS = 4_000;

/** 与原生 DeepSeek 适配器相同的推理等级词汇表，切换供应商时选择不丢失。 */
const OFF_REASONING_EFFORT = ReasoningEffortId("off");
const HIGH_REASONING_EFFORT = ReasoningEffortId("high");
const MAX_REASONING_EFFORT = ReasoningEffortId("max");
const REASONING_EFFORTS: readonly LlmReasoningEffortInfo[] = [
  { id: OFF_REASONING_EFFORT, name: "Off" },
  { id: HIGH_REASONING_EFFORT, name: "High" },
  { id: MAX_REASONING_EFFORT, name: "Max" },
];

export interface Config {
  /** chat completions 端点。 */
  baseUrl?: string;
  /** 模型列表端点（用于自动发现 `*-free` 模型）。 */
  modelsUrl?: string;
  /** 未在列表中的模型使用的上下文容量。 */
  contextWindow?: number;
  /** 固定模型清单；为空时启动时从 modelsUrl 拉取并过滤 `*-free`。 */
  models?: string[];
  /** 每请求默认输出上限。 */
  maxTokens?: number;
  /** 默认推理等级（与原生 deepseek 一致，默认 high）。 */
  reasoningEffort?: "off" | "high" | "max";
}

export const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  modelsUrl: z.string().default(DEFAULT_MODELS_URL),
  contextWindow: z.number().default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(z.string()).default([DEFAULT_MODEL]),
  maxTokens: z.number().default(8192),
  reasoningEffort: z.union(["off", "high", "max"]).default("high"),
});

interface OpenAiMessage {
  role: string;
  content: string;
}

interface OpenAiResponse {
  choices?: {
    index?: number;
    finish_reason?: string | null;
    message?: { content?: string | null; reasoning_content?: string | null };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    reasoning_tokens?: number;
  };
  error?: { message?: string; type?: string };
}

interface ModelList {
  data?: { id?: string }[];
}

/** 从 harness Message 提取纯文本块（图片/工具结果等非文本块不发送）。 */
function textContent(message: Message): string {
  const parts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") parts.push(part.text);
  }
  return parts.join("\n");
}

function serializeMessages(
  system: string | undefined,
  messages: readonly Message[],
): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  if (system !== undefined && system.length > 0)
    out.push({ role: "system", content: system });
  for (const message of messages) {
    out.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: textContent(message),
    });
  }
  return out;
}

function mapFinishReason(reason: string | null | undefined): FinishReason {
  return reason === "length" ? { kind: "max-tokens" } : { kind: "stop" };
}

/** 校验推理等级：只接受与原生 DeepSeek 相同的 off/high/max（运行时已按声明清单预校验，这里是直达适配器的兜底）。 */
function validateReasoningEffort(effort: string): "off" | "high" | "max" {
  if (effort === "off" || effort === "high" || effort === "max") return effort;
  throw new LlmError(
    `OpenCode Free does not support reasoning effort "${effort}"`,
    "UNSUPPORTED_REASONING_EFFORT",
  );
}

/**
 * 与原生 DeepSeek 适配器相同的 HTTP 错误归类。关键：400 + 上下文超限措辞
 * 归类为 CONTEXT_WINDOW_EXCEEDED——harness 的 compaction-basic 会对该代码
 * 自动压缩并重试（本插件另有 overflow-recovery 兜底）。
 */
function httpErrorCode(status: number, detail: string): string {
  if (status === 401 || status === 403) return "AUTH";
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
  if (status === 429) return "RATE_LIMIT";
  if (status === 400) {
    if (isContextWindowExceededError(detail))
      return CONTEXT_WINDOW_EXCEEDED_CODE;
    return "INVALID_REQUEST";
  }
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}

/**
 * 与原生 DeepSeek 适配器相同的思考/推理等级解析：off 关闭思考（thinking disabled），
 * high/max 开启并带上 reasoning_effort（zen 网关已验证接受该参数）。会话标题生成不思考。
 */
function resolveThinking(options: GenerateOptions): {
  thinking?: "enabled" | "disabled";
  reasoningEffort?: "high" | "max";
} {
  if (options.purpose === "session-title") return { thinking: "disabled" };
  const effort =
    options.reasoningEffort === undefined
      ? undefined
      : validateReasoningEffort(options.reasoningEffort);
  if (effort === "off") return { thinking: "disabled" };
  if (effort === "high" || effort === "max") return { reasoningEffort: effort };
  return {};
}

class OpenCodeAdapter extends LlmAdapter {
  /** 会话生命周期缓存：第一次 listModels 后不再拉取。 */
  private modelsCache: LlmModelInfo[] | null = null;

  constructor(private readonly config: Config) {
    super();
  }

  providerInfo(provider: string) {
    return { id: provider, name: "OpenCode Free" };
  }

  /**
   * 模型列表：成功结果会话生命周期缓存（只拉一次，之后秒回）；拉取带 4s
   * 超时。失败时返回配置清单（至少含默认模型）且**不缓存**——下次打开
   * 选择器会重试，网络恢复后列表自动出现。
   */
  async listModels(provider: string): Promise<LlmModelInfo[]> {
    if (this.modelsCache !== null) return this.modelsCache;
    const ids = new Set(this.config.models ?? []);
    let succeeded = false;
    try {
      const response = await fetch(
        this.config.modelsUrl ?? DEFAULT_MODELS_URL,
        {
          headers: attributionHeaders(),
          signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
        },
      );
      if (response.ok) {
        const parsed = (await response.json()) as ModelList;
        for (const item of parsed.data ?? []) {
          if (item.id !== undefined && item.id.endsWith(FREE_SUFFIX))
            ids.add(item.id);
        }
        succeeded = true;
      }
    } catch {
      // 网络失败：退回配置清单，不缓存，下次重试。
    }
    const list = Array.from(ids).map((id) => ({ provider, id, name: id }));
    if (succeeded) this.modelsCache = list;
    return list;
  }

  async resolveModel(
    provider: string,
    model: string,
  ): Promise<LlmResolvedModelInfo> {
    const configured = this.config.reasoningEffort;
    const defaultEffort =
      configured === "off"
        ? OFF_REASONING_EFFORT
        : configured === "max"
          ? MAX_REASONING_EFFORT
          : HIGH_REASONING_EFFORT;
    return {
      provider,
      id: model,
      name: model,
      context: {
        contextWindow: this.config.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      },
      ...(this.config.maxTokens !== undefined
        ? { defaultMaxTokens: this.config.maxTokens }
        : {}),
      reasoning: { efforts: REASONING_EFFORTS, defaultEffort },
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: serializeMessages(options.system, options.messages),
      stream: false,
      max_tokens: options.maxTokens ?? this.config.maxTokens ?? 8192,
    };
    if (options.temperature !== undefined)
      body.temperature = options.temperature;
    if (options.stop !== undefined && options.stop.length > 0)
      body.stop = options.stop;

    const thinking = resolveThinking(options);
    if (thinking.thinking !== undefined)
      body.thinking = { type: thinking.thinking };
    if (thinking.reasoningEffort !== undefined)
      body.reasoning_effort = thinking.reasoningEffort;

    let response: Response;
    try {
      response = await fetch(this.config.baseUrl ?? DEFAULT_BASE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...attributionHeaders(),
        },
        body: JSON.stringify(body),
        signal: options.signal ?? null,
      });
    } catch (error: unknown) {
      if (options.signal?.aborted) {
        throw new LlmError("opencode request aborted by caller", "ABORTED", {
          cause: error,
        });
      }
      throw new LlmError("opencode API request failed", "TRANSPORT", {
        cause: error,
      });
    }

    if (!response.ok) {
      let message = `opencode API error (HTTP ${response.status})`;
      let detail = "";
      try {
        const parsed = (await response.json()) as OpenAiResponse;
        if (parsed.error?.message !== undefined) message = parsed.error.message;
        detail = [parsed.error?.type, parsed.error?.message]
          .filter(Boolean)
          .join(" ");
      } catch {
        // 错误体解析失败时保留状态码信息。
      }
      throw new LlmError(message, httpErrorCode(response.status, detail), {
        status: response.status,
      });
    }

    const parsed = (await response.json()) as OpenAiResponse;
    const choice = parsed.choices?.[0];
    const reasoning = choice?.message?.reasoning_content ?? undefined;
    const content = choice?.message?.content ?? undefined;

    if (reasoning !== undefined && reasoning.length > 0) {
      yield { type: "block-start", index: 0, blockType: "reasoning" };
      yield { type: "reasoning-delta", index: 0, text: reasoning };
      yield {
        type: "block-end",
        index: 0,
        block: { type: "reasoning", text: reasoning },
      };
    }
    const textIndex = reasoning !== undefined && reasoning.length > 0 ? 1 : 0;
    if (content !== undefined && content.length > 0) {
      yield { type: "block-start", index: textIndex, blockType: "text" };
      yield { type: "text-delta", index: textIndex, text: content };
      yield {
        type: "block-end",
        index: textIndex,
        block: { type: "text", text: content },
      };
    }

    const usage: TokenUsage = {
      inputTokens: parsed.usage?.prompt_tokens ?? 0,
      outputTokens: parsed.usage?.completion_tokens ?? 0,
      ...(parsed.usage?.reasoning_tokens !== undefined
        ? { reasoningTokens: parsed.usage.reasoning_tokens }
        : {}),
    };
    yield { type: "usage", usage };
    yield {
      type: "finish",
      reason: mapFinishReason(choice?.finish_reason),
      replayState: { model: options.model },
    };
  }
}

/** 注册「OpenCode Free」provider（路由 opencode-free），自动提供 *-free 模型。 */
export function apply(ctx: Context, config: Config): void {
  ctx.llm.registerAdapter(["opencode-free"], new OpenCodeAdapter(config));
}
