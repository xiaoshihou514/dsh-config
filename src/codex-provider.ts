import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import z from "@deepseek-ai/schemastery";
import {
  resolveRetryPolicy,
  type RetryPolicyConfig,
} from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import type { ResolvedPiAiProviderProfile } from "@deepseek-ai/dsh-llm-pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  InMemoryCredentialStore,
  defaultProviderAuthContext,
} from "@earendil-works/pi-ai";
import type {
  OAuthAuth,
  OAuthCredential,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import {
  codexAuthFile,
  codexPlan,
  codexSubscriptionAccessToken,
  hasCodexSubscription,
  saveCodexCredentials,
} from "./codex-auth.ts";

export const name = "dsh-config-codex-provider";
export const inject = ["llm", "webServer"];

export const PROVIDER = "openai-codex";
/** 各账户档位的可用模型白名单（access_token 的 auth claim.plan）。 */
const PLAN_MODELS: Record<string, readonly string[]> = {
  free: ["gpt-5.6-luna", "gpt-6-luna", "gpt-5.6-terra"],
};
/** 已停产的目录模型：网关一律拒绝（400 not supported），不再暴露。 */
const DEAD_MODELS = new Set(["gpt-5.3-codex-spark"]);
/** 档位缓存：登录/启动后异步解析（目录读取为同步访问）。 */
let planCache: string | undefined;

async function refreshPlan(): Promise<void> {
  try {
    planCache = (await codexPlan()) ?? "";
  } catch {
    planCache = "";
  }
}

// 模块加载即解析档位（1 次本地文件读）：此后目录读取永远拿到确定值。
await refreshPlan();

/** 按档位收窄目录：未知档位不收窄（保底全集）。 */
/** pi-ai Provider 类型的目录字段未在类型上暴露；运行时由 createProvider 写入。 */
function catalogModels(provider: unknown): { id: string }[] {
  const getModels = (provider as { getModels?: () => { id: string }[] }).getModels;
  if (typeof getModels === "function") return getModels.call(provider);
  return (provider as { models?: { id: string }[] }).models ?? [];
}

function availableModels<T extends { id: string }>(
  catalog: readonly T[],
): T[] {
  const allow =
    planCache !== undefined && planCache !== ""
      ? PLAN_MODELS[planCache]
      : undefined;
  return catalog.filter(
    (model) =>
      !DEAD_MODELS.has(model.id) &&
      (allow === undefined || allow.includes(model.id)),
  );
}

const LOGIN_ROUTE = "/dsh-config/codex-login";
const LOGIN_HEADER = "x-dsh-config";
const LOGIN_HEADER_VALUE = "codex-login";


/** 与 opencode free 同款的限流/网络错误指数退避：1s 起步 ×2、封顶 30s、20% 抖动、最多 3 次重试。 */
const CODEX_RETRY_POLICY: RetryPolicyConfig = {
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

export type CodexLoginStatus =
  | { state: "idle" }
  | { state: "pending"; url?: string }
  | { state: "success" }
  | { state: "error"; message: string };

export class CodexLoginManager {
  private value: CodexLoginStatus = { state: "idle" };
  private controller: AbortController | undefined;

  constructor(
    private readonly oauth: OAuthAuth,
    private readonly authFile = codexAuthFile(),
  ) {}

  status(): CodexLoginStatus {
    return this.value;
  }

  async currentStatus(): Promise<CodexLoginStatus> {
    if (
      this.value.state === "idle" &&
      (await hasCodexSubscription(this.authFile))
    ) {
      this.value = { state: "success" };
    }
    return this.value;
  }

  async start(): Promise<CodexLoginStatus> {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    this.value = { state: "pending" };
    let reveal: (() => void) | undefined;
    const revealed = new Promise<void>((resolve) => {
      reveal = resolve;
    });
    const interaction: ProviderAuthInteraction = {
      signal: controller.signal,
      prompt: async (prompt) => {
        if (prompt.type === "select") return "browser";
        return new Promise<string>((_resolve, reject) => {
          const signal = prompt.signal ?? controller.signal;
          if (signal.aborted) {
            reject(new Error("登录已取消"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(new Error("登录已取消")),
            { once: true },
          );
        });
      },
      notify: (event) => {
        if (event.type !== "auth_url") return;
        this.value = { state: "pending", url: event.url };
        reveal?.();
      },
    };
    const run = this.oauth
      .login(interaction)
      .then(async (credential: OAuthCredential) => {
        if (this.controller !== controller) return;
        await saveCodexCredentials(this.authFile, credential);
        void refreshPlan(); // 新账户：档位待重新解析。
        this.value = { state: "success" };
        reveal?.();
      })
      .catch((error: unknown) => {
        if (this.controller !== controller) return;
        if (controller.signal.aborted) {
          this.value = { state: "idle" };
        } else {
          const detail = error instanceof Error ? error.message : String(error);
          this.value = { state: "error", message: `登录失败：${detail}` };
        }
        reveal?.();
      })
      .finally(() => {
        if (this.controller === controller) this.controller = undefined;
      });
    void run;
    await revealed;
    return this.value;
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = undefined;
    if (this.value.state === "pending") this.value = { state: "idle" };
  }
}

function writeJson(
  response: Parameters<WebRoute["handler"]>[1],
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

export function createCodexAdapter(ctx?: Context): PiAiAdapter {
  const catalogProvider = openaiCodexProvider();
  const oauth = catalogProvider.auth.oauth;
  if (oauth === undefined)
    throw new Error("Codex 模型提供方没有提供订阅登录能力");
  // PiAiAdapter supplies a per-request token through its API-key override.
  // Codex is OAuth-only in the upstream catalog, so expose that override as a
  // request-scoped auth method while retaining the native OAuth implementation
  // for refreshes. No token is discovered from the environment.
  const piProvider = {
    ...catalogProvider,
    // 目录按账户实际可用性动态收窄（ChatGPT 免费档只能用部分模型）：
    // 有宿主上下文时后台探测（TTL 1 小时），结果未就绪前先给全集；
    // headless（无 ctx）不发探测，保持全集。
    // pi-ai 的目录消费走 Provider.getModels()（spread 会带上原目录的
    // getModels，必须覆盖），models 数据属性仅为类型兼容保留。
    getModels() {
      return availableModels(catalogModels(catalogProvider));
    },
    get models() {
      return availableModels(catalogModels(catalogProvider));
    },
    auth: {
      ...catalogProvider.auth,
      apiKey: {
        name: "Codex 订阅令牌",
        resolve: async (input: {
          credential?: { key?: string };
        }) =>
          input.credential?.key === undefined
            ? undefined
            : {
                auth: { apiKey: input.credential.key },
                source: "Codex CLI 登录",
              },
      },
    },
  } as unknown as typeof catalogProvider;

  // 见 copilot-provider.ts 同名注释：插件与宿主的 pi-ai 版本并存，
  // refreshModels 类型不兼容但适配器从不调用它。
  const profile: ResolvedPiAiProviderProfile = {
    provider: PROVIDER,
    displayName: "Codex 订阅",
    streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    retryPolicy: resolveRetryPolicy(CODEX_RETRY_POLICY, "Codex 订阅重试策略"),
    piProvider:
      piProvider as NonNullable<ResolvedPiAiProviderProfile["piProvider"]>,
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
  };
  const profiles = new Map([[PROVIDER, profile]]);

  return new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: () => codexSubscriptionAccessToken(oauth),
    auth: {
      credentials: new InMemoryCredentialStore(),
      authContext: defaultProviderAuthContext(),
    },
    // Native Codex image input needs the host's durable attachment store to
    // resolve image references into request bytes. Keep this optional so the
    // exported adapter remains usable in catalog-only tests/headless hosts.
    resolveAttachments: () => ctx?.get("attachments"),
  });
}

export function apply(ctx: Context): void {
  const catalogProvider = openaiCodexProvider();
  const oauth = catalogProvider.auth.oauth;
  if (oauth === undefined)
    throw new Error("Codex 模型提供方没有提供订阅登录能力");
  const login = new CodexLoginManager(oauth);
  ctx.llm.registerAdapter([PROVIDER], createCodexAdapter(ctx));
  const route: WebRoute = {
    kind: "exact",
    path: LOGIN_ROUTE,
    handler: async (request, response) => {
      if (request.headers[LOGIN_HEADER] !== LOGIN_HEADER_VALUE) {
        response.writeHead(403).end();
        return;
      }
      if (request.method === "GET") {
        writeJson(response, 200, {
          ok: true,
          ...(await login.currentStatus()),
        });
        return;
      }
      if (request.method === "POST") {
        const status = await login.start();
        writeJson(response, status.state === "error" ? 500 : 200, {
          ok: status.state !== "error",
          ...status,
        });
        return;
      }
      if (request.method === "DELETE") {
        login.cancel();
        writeJson(response, 200, { ok: true, state: "idle" });
        return;
      }
      response.writeHead(405, { allow: "GET, POST, DELETE" }).end();
    },
  };
  ctx.effect(() => ctx.webServer.register(route), "dsh-config: Codex 订阅登录");
}
