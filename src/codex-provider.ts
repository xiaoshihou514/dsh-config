import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
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
  AuthInteraction,
  OAuthAuth,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import {
  codexAuthFile,
  codexSubscriptionAccessToken,
  hasCodexSubscription,
  saveCodexCredentials,
} from "./codex-auth.ts";

export const name = "dsh-config-codex-provider";
export const inject = ["llm", "settings", "webServer"];

export const PROVIDER = "openai-codex";
const LOGIN_ROUTE = "/dsh-config/codex-login";
const LOGIN_HEADER = "x-dsh-config";
const LOGIN_HEADER_VALUE = "codex-login";

/** 设置命名空间：仅作为“Codex 订阅登录”卡片在插件配置标签页的派发键，凭据存在 codex auth.json。 */
const SETTINGS_NAMESPACE = settingsNamespace("dsh-config-codex-login");

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
    const interaction: AuthInteraction = {
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

export function createCodexAdapter(): PiAiAdapter {
  const catalogProvider = openaiCodexProvider();
  const oauth = catalogProvider.auth.oauth;
  if (oauth === undefined)
    throw new Error("Codex 模型提供方没有提供订阅登录能力");
  // PiAiAdapter supplies a per-request token through its API-key override.
  // Codex is OAuth-only in the upstream catalog, so expose that override as a
  // request-scoped auth method while retaining the native OAuth implementation
  // for refreshes. No token is discovered from the environment.
  const piProvider: typeof catalogProvider = {
    ...catalogProvider,
    auth: {
      ...catalogProvider.auth,
      apiKey: {
        name: "Codex 订阅令牌",
        resolve: async ({ credential }) =>
          credential?.key === undefined
            ? undefined
            : { auth: { apiKey: credential.key }, source: "Codex CLI 登录" },
      },
    },
  };

  const profile: ResolvedPiAiProviderProfile = {
    provider: PROVIDER,
    displayName: "Codex 订阅",
    streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    retryPolicy: resolveRetryPolicy(CODEX_RETRY_POLICY, "Codex 订阅重试策略"),
    piProvider,
    configuredMaxTokens: new Map(),
  };
  const profiles = new Map([[PROVIDER, profile]]);

  return new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: () => codexSubscriptionAccessToken(oauth),
    auth: {
      credentials: new InMemoryCredentialStore(),
      authContext: defaultProviderAuthContext(),
    },
  });
}

export function apply(ctx: Context): void {
  ctx.settings.register(SETTINGS_NAMESPACE, z.object({}));
  const catalogProvider = openaiCodexProvider();
  const oauth = catalogProvider.auth.oauth;
  if (oauth === undefined)
    throw new Error("Codex 模型提供方没有提供订阅登录能力");
  const login = new CodexLoginManager(oauth);
  ctx.llm.registerAdapter([PROVIDER], createCodexAdapter());
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
