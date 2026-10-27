import { readFileSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import z from "@deepseek-ai/schemastery";
import {
  resolveRetryPolicy,
  type RetryPolicyConfig,
} from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import type { ResolvedPiAiProviderProfile } from "@deepseek-ai/dsh-llm-pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
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
  copilotAuthFile,
  copilotSubscriptionAccessToken,
  hasCopilotSubscription,
  saveCopilotCredentials,
} from "./copilot-auth.ts";

export const name = "dsh-config-copilot-provider";
export const inject = ["llm", "webServer"];

export const PROVIDER = "github-copilot";
const LOGIN_ROUTE = "/dsh-config/copilot-login";
const LOGIN_HEADER = "x-dsh-config";
const LOGIN_HEADER_VALUE = "copilot-login";

/** pi-ai Provider 类型的目录字段未在类型上暴露；运行时由 createProvider 写入。 */
function catalogModels(provider: unknown): { id: string }[] {
  const source = provider as {
    getModels?: () => { id: string }[];
    models?: { id: string }[];
  };
  if (typeof source.getModels === "function") return source.getModels();
  return source.models ?? [];
}


/** 与 codex/opencode free 同款的限流/网络错误指数退避：1s 起步 ×2、封顶 30s、20% 抖动、最多 3 次重试。 */
const COPILOT_RETRY_POLICY: RetryPolicyConfig = {
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

/**
 * 凭据文件里 pi-ai 回写的当前账户可用模型清单：Copilot 按套餐分级开放
 * 模型（免费档没有 opus 等），登录/令牌刷新时 pi-ai 从 `/models` 拉
 * 「模型选择器可见且策略未禁用」的清单回写 `availableModelIds`。
 * 读不到文件或字段时返回 undefined（保底全集，不猜测套餐）。
 */
export function copilotAvailableModelIds(
  authFile = copilotAuthFile(),
): Set<string> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(authFile, "utf8")) as {
      availableModelIds?: unknown;
    };
    if (!Array.isArray(parsed.availableModelIds)) return undefined;
    const ids = parsed.availableModelIds.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    return ids.length > 0 ? new Set(ids) : undefined;
  } catch {
    return undefined;
  }
}

/** 目录 ∩ 账户可用清单；无清单时原样返回全集。 */
export function filterCopilotModels<T extends { id: string }>(
  catalog: readonly T[],
  available: Set<string> | undefined,
): T[] {
  if (available === undefined) return [...catalog];
  return catalog.filter((model) => available.has(model.id));
}

export type CopilotLoginStatus =
  | { state: "idle" }
  | { state: "pending"; url?: string; userCode?: string }
  | { state: "success" }
  | { state: "error"; message: string };

export class CopilotLoginManager {
  private value: CopilotLoginStatus = { state: "idle" };
  private controller: AbortController | undefined;

  constructor(
    private readonly oauth: OAuthAuth,
    private readonly authFile = copilotAuthFile(),
  ) {}

  status(): CopilotLoginStatus {
    return this.value;
  }

  async currentStatus(): Promise<CopilotLoginStatus> {
    if (
      this.value.state === "idle" &&
      (await hasCopilotSubscription(this.authFile))
    ) {
      this.value = { state: "success" };
    }
    return this.value;
  }

  async start(): Promise<CopilotLoginStatus> {
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
        // Copilot 设备码登录先询问 GitHub Enterprise 域名：个人版订阅直接回
        // 空串（即 github.com），不打扰用户；取消则中断整个流程。
        const signal = prompt.signal ?? controller.signal;
        if (signal.aborted) throw new Error("登录已取消");
        return "";
      },
      notify: (event) => {
        if (event.type !== "device_code") return;
        this.value = {
          state: "pending",
          url: event.verificationUri,
          userCode: event.userCode,
        };
        reveal?.();
      },
    };
    const run = this.oauth
      .login(interaction)
      .then(async (credential: OAuthCredential) => {
        if (this.controller !== controller) return;
        await saveCopilotCredentials(this.authFile, credential);
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

export function createCopilotAdapter(ctx?: Context): PiAiAdapter {
  const catalogProvider = githubCopilotProvider();
  const oauth = catalogProvider.auth.oauth;
  if (oauth === undefined)
    throw new Error("GitHub Copilot 模型提供方没有提供订阅登录能力");
  // PiAiAdapter supplies a per-request token through its API-key override.
  // Copilot is OAuth-only in the upstream catalog, so expose that override as
  // a request-scoped auth method while retaining the native OAuth
  // implementation for refreshes. No token is discovered from the environment.
  // 与 Codex 的差别：Codex 端点固定，Copilot 的会话令牌内嵌 proxy-ep
  // 推导出的 baseUrl 恰与目录默认值（api.individual.githubcopilot.com）
  // 一致，因此 apiKey 覆盖路径对 Copilot Pro 个人版无损。
  const piProvider: typeof catalogProvider = {
    ...catalogProvider,
    // 模型分级过滤：pi-ai 自带的 filterModels 从凭据仓取 OAuth 记录，而
    // 本适配器走每请求令牌注入（凭据仓恒空），那条路径永远拿不到凭据；
    // 改在这里按凭据文件回写的 availableModelIds 过滤。注意 PiAiAdapter
    // 的快照按 profiles 身份记忆——目录只在适配器创建（宿主启动/重建）时
    // 读取一次，之后凭据清单变化要等下次重建才反映；无清单时保底全集。
    getModels() {
      return filterCopilotModels(
        catalogModels(catalogProvider),
        copilotAvailableModelIds(),
      );
    },
    get models() {
      return filterCopilotModels(
        catalogModels(catalogProvider),
        copilotAvailableModelIds(),
      );
    },
    auth: {
      ...catalogProvider.auth,
      apiKey: {
        name: "Copilot 订阅令牌",
        resolve: async (input: { credential?: { key?: string } }) =>
          input.credential?.key === undefined
            ? undefined
            : {
                auth: { apiKey: input.credential.key },
                source: "Copilot 订阅登录",
              },
      },
    },
  } as unknown as typeof catalogProvider;

  // 本插件自带 pi-ai（0.84.x，模型目录更新）与宿主 dsh-llm-pi-ai 内置的
  // pi-ai（0.82.x）并存；两侧 Provider 类型在 refreshModels 上下文上不兼容，
  // 但适配器只读取目录与发起流式调用，从不调用 refreshModels，运行时已验证。
  const profile: ResolvedPiAiProviderProfile = {
    provider: PROVIDER,
    displayName: "Copilot 订阅",
    streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    retryPolicy: resolveRetryPolicy(COPILOT_RETRY_POLICY, "Copilot 订阅重试策略"),
    piProvider:
      piProvider as NonNullable<ResolvedPiAiProviderProfile["piProvider"]>,
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
  };
  const profiles = new Map([[PROVIDER, profile]]);

  return new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: () => copilotSubscriptionAccessToken(oauth),
    auth: {
      credentials: new InMemoryCredentialStore(),
      authContext: defaultProviderAuthContext(),
    },
    // Image input needs the host's durable attachment store to resolve image
    // references into request bytes. Keep this optional so the exported
    // adapter remains usable in catalog-only tests/headless hosts.
    resolveAttachments: () => ctx?.get("attachments"),
  });
}

export function apply(ctx: Context): void {
  const catalogProvider = githubCopilotProvider();
  const oauth = catalogProvider.auth.oauth;
  if (oauth === undefined)
    throw new Error("GitHub Copilot 模型提供方没有提供订阅登录能力");
  const login = new CopilotLoginManager(oauth);
  ctx.llm.registerAdapter([PROVIDER], createCopilotAdapter(ctx));
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
  ctx.effect(() => ctx.webServer.register(route), "dsh-config: Copilot 订阅登录");
}
