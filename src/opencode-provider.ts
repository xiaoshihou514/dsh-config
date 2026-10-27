/**
 * OpenCode Free 经本地 OpenAI 兼容代理接入（opencode-llm-proxy 等网关）：
 * dsh 侧退化为标准 openai-completions 客户端，由 pi-ai 原生适配——工具调用、
 * 流式、多轮消息、推理等级（标准 reasoning_effort 词汇表）与系统提示全部
 * 经代理透传给上游模型，不再直连 opencode zen 网关做仿 CLI 头与占位工具
 * 注入等 hack（那套实现随 zen 免费网关的策略变化反复失效，已整体移除）。
 *
 * 模型清单：配置 `models` 优先；为空时启动时从代理的 `/models` 自动发现
 * `*-free` 模型（拉取失败则目录为空，部署代理并重启宿主后出现）。模型目录
 * 在适配器创建（宿主启动）时物化，运行期不变。
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import {
  InMemoryCredentialStore,
  createProvider,
  defaultProviderAuthContext,
  lazyApi,
} from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import type { ResolvedPiAiProviderProfile } from "@deepseek-ai/dsh-llm-pi-ai";
import {
  resolveRetryPolicy,
  RetryPolicySchema,
  type RetryPolicyConfig,
} from "@deepseek-ai/dsh-llm";

export const name = "dsh-config-opencode";
export const inject = ["llm"];

export const PROVIDER = "opencode-free";

/** 本地 OpenAI 兼容代理地址（opencode-llm-proxy 默认端口 8080）。 */
const DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
/** 与官方 CLI 对齐（32000）：8192 会截断长回复。 */
const DEFAULT_MAX_TOKENS = 32_000;
const FREE_SUFFIX = "-free";
const MODELS_FETCH_TIMEOUT_MS = 4_000;

/** 与 codex/copilot 同款的限流/网络错误指数退避。 */
const DEFAULT_RETRY_POLICY: RetryPolicyConfig = {
  mode: "normal",
  maxRetries: 3,
  retryableCodes: [
    "EMPTY_RESPONSE",
    "RATE_LIMIT",
    "SERVER",
    "TIMEOUT",
    "TRANSPORT",
  ],
  backoff: { initialDelayMs: 1_000, maxDelayMs: 30_000, jitterRatio: 0.2 },
};

export interface Config {
  /** 代理的 OpenAI 兼容 base URL（含 /v1）。 */
  baseUrl?: string;
  /** 代理 API 密钥（本地代理通常不需要；未配置时发送占位 Bearer）。 */
  apiKey?: string;
  /** 固定模型 id 清单；为空时启动时从 modelsUrl 自动发现 `*-free`。 */
  models?: string[];
  /** 模型列表端点（默认 {baseUrl}/models）。 */
  modelsUrl?: string;
  /** 模型上下文容量（词元）。 */
  contextWindow?: number;
  /** 每请求默认输出上限（词元）。 */
  maxTokens?: number;
  /** 限流/网络错误的指数退避重试策略。 */
  retryPolicy?: RetryPolicyConfig;
}

export const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  apiKey: z.string().default(""),
  models: z.array(z.string()).default([]),
  modelsUrl: z.string().default(""),
  contextWindow: z.number().default(DEFAULT_CONTEXT_WINDOW),
  maxTokens: z.number().default(DEFAULT_MAX_TOKENS),
  retryPolicy: RetryPolicySchema.default(DEFAULT_RETRY_POLICY),
});

/** Config schema 填充默认值后的运行时形态。 */
export interface ResolvedConfig {
  baseUrl: string;
  apiKey: string;
  models: string[];
  modelsUrl: string;
  contextWindow: number;
  maxTokens: number;
  retryPolicy: RetryPolicyConfig;
}

/** 目录模型描述：免费档不按词元计费，cost 恒 0。 */
function modelOf(id: string, config: ResolvedConfig): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: PROVIDER,
    baseUrl: config.baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
  };
}

/** 代理的模型列表端点（未配置时按 OpenAI 惯例取 {baseUrl}/models）。 */
function modelsUrlOf(config: ResolvedConfig): string {
  return config.modelsUrl !== "" ? config.modelsUrl : `${config.baseUrl}/models`;
}

/**
 * 启动时从代理拉取模型清单并过滤 `*-free`（OpenAI 兼容 {data:[{id}]} 响应）。
 * 失败返回空清单：目录为空但 provider 不崩，代理可用后重启宿主即出现。
 */
export async function discoverModels(config: ResolvedConfig): Promise<string[]> {
  if (config.models.length > 0) return config.models;
  try {
    const response = await fetch(modelsUrlOf(config), {
      signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const parsed = (await response.json()) as { data?: { id?: string }[] };
    return (parsed.data ?? [])
      .map((item) => item.id ?? "")
      .filter((id) => id.endsWith(FREE_SUFFIX));
  } catch {
    return [];
  }
}

export function createOpencodeAdapter(
  config: ResolvedConfig,
  ctx?: Context,
): PiAiAdapter {
  const piProvider = createProvider({
    id: PROVIDER,
    name: "OpenCode Free",
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: "opencode 代理密钥",
        resolve: async (input: { credential?: { key?: string } }) =>
          input.credential?.key === undefined
            ? undefined
            : {
                auth: { apiKey: input.credential.key },
                source: "opencode 代理",
              },
      },
    },
    models: config.models.map((id) => modelOf(id, config)),
    // 与上游 openAICompletionsApi() 同款：懒加载 completions 实现。
    api: lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions")),
  });

  const profile: ResolvedPiAiProviderProfile = {
    provider: PROVIDER,
    displayName: "OpenCode Free",
    streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    retryPolicy: resolveRetryPolicy(
      config.retryPolicy,
      "opencode-free retryPolicy",
    ),
    piProvider:
      piProvider as NonNullable<ResolvedPiAiProviderProfile["piProvider"]>,
    // 每模型默认输出上限：经此 Map 物化为 resolveModel 的 defaultMaxTokens
    // 与请求默认 cap（不进 Map 则只作用于目录，不作用于请求）。
    configuredMaxTokens: new Map(
      config.models.map((id) => [id, config.maxTokens]),
    ),
    modelErrors: new Map(),
  };
  const profiles = new Map([[PROVIDER, profile]]);

  return new PiAiAdapter({
    profiles: () => profiles,
    // 本地代理通常无认证；zen 免费档也接受 Bearer public。显式配置的
    // apiKey 优先（带鉴权的代理场景）。
    resolveApiKey: async () => (config.apiKey !== "" ? config.apiKey : "public"),
    auth: {
      credentials: new InMemoryCredentialStore(),
      authContext: defaultProviderAuthContext(),
    },
    resolveAttachments: () => ctx?.get("attachments"),
  });
}

/** 注册「OpenCode Free」provider（路由 opencode-free），经本地代理透传。 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  void discoverModels(config).then((models) => {
    ctx.llm.registerAdapter(
      [PROVIDER],
      createOpencodeAdapter({ ...config, models }, ctx),
    );
  });
}
