/**
 * OpenCode Free 经本地 opencode-llm-proxy 网关接入（零配置，全部写死）：
 *
 * opencode-llm-proxy 是 OpenCode 的官方生态插件，随 opencode 进程在本机
 * 4010 端口起一个 OpenAI 兼容网关（/v1/chat/completions，流式 + 工具调用
 * 透传）。dsh 侧因此退化为标准 openai-completions 客户端，不再直连
 * opencode zen 网关做仿 CLI 头等 hack。
 *
 * 「选 opencode free 模型就有一个可用代理」由本插件保证（自动拉起）：
 *
 *  1. 4010 已监听（用户自己开着 opencode）→ 直接用；
 *  2. 未监听 → 确保插件包安装（~/.config/opencode 下 npm install）→ 确保
 *     opencode.json 声明 plugin → 后台拉起 `opencode serve` → 轮询就绪；
 *  3. 就绪后模型清单切换为代理实际提供的 `*-free` 模型；不可达期间用内置
 *     已知清单兜底（目录不隐藏，请求失败交由重试策略与错误归类处理）。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import {
  InMemoryCredentialStore,
  createProvider,
  defaultProviderAuthContext,
  lazyApi,
} from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import type { ResolvedPiAiProviderProfile } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveRetryPolicy, type RetryPolicyConfig } from "@deepseek-ai/dsh-llm";

export const name = "dsh-config-opencode";
export const inject = ["llm"];

export const PROVIDER = "opencode-free";

/** opencode-llm-proxy 的固定地址（OpenAI 兼容，含 /v1）。 */
const PROXY_BASE = "http://127.0.0.1:4010/v1";
const PROXY_HEALTH = "http://127.0.0.1:4010/health";
/** opencode server 的端口（llm-proxy 插件随 opencode 进程启动）。 */
const OPENCODE_SERVE_PORT = 4096;
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
/** 与官方 CLI 对齐（32000）：8192 会截断长回复。 */
const DEFAULT_MAX_TOKENS = 32_000;
const FREE_SUFFIX = "-free";
const HEALTH_TIMEOUT_MS = 1_500;
const BOOTSTRAP_TIMEOUT_MS = 60_000;
const OPENCODE_CONFIG_DIR = join(homedir(), ".config", "opencode");

/** 内置兜底清单：代理不可达时目录不空（用量历史中真实出现过的 free 模型）。 */
const FALLBACK_MODELS = [
  "deepseek-v4.1-flash-free",
  "mimo-v2.5-free",
  "x-preview-f-free",
];

/** 与 codex/copilot 同款的限流/网络错误指数退避。 */
const RETRY_POLICY = {
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
} satisfies RetryPolicyConfig;

/** 当前模型清单（代理就绪后刷新为实际提供的 *-free 模型）。 */
let modelIds: string[] = [...FALLBACK_MODELS];

function modelOf(id: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: PROVIDER,
    baseUrl: PROXY_BASE,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** 从代理拉取 *-free 模型清单；成功且非空时更新缓存。 */
async function refreshModels(): Promise<void> {
  const parsed = (await fetchJson(`${PROXY_BASE}/models`, 5_000)) as {
    data?: { id?: string }[];
  };
  const ids = (parsed.data ?? [])
    .map((item) => item.id ?? "")
    .filter((id) => id.endsWith(FREE_SUFFIX));
  if (ids.length > 0) modelIds = ids;
}

/** opencode 可执行文件：PATH 上的 opencode 或默认安装位置。 */
function opencodeBin(): string {
  if (existsSync(join(homedir(), ".opencode", "bin", "opencode")))
    return join(homedir(), ".opencode", "bin", "opencode");
  return "opencode";
}

/** 插件包是否已安装到 opencode 配置目录。 */
function pluginInstalled(): boolean {
  return existsSync(
    join(OPENCODE_CONFIG_DIR, "node_modules", "opencode-llm-proxy"),
  );
}

function execFile(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout: ${command}`));
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`exit ${code}: ${command}`));
    });
  });
}

/** 确保 ~/.config/opencode 里装了 opencode-llm-proxy（幂等）。 */
async function ensurePluginInstalled(): Promise<void> {
  if (pluginInstalled()) return;
  await execFile(
    "npm",
    ["install", "opencode-llm-proxy", "--no-audit", "--no-fund", "--silent"],
    { cwd: OPENCODE_CONFIG_DIR, timeoutMs: 30_000 },
  );
}

/**
 * 确保 opencode.json 声明了 llm-proxy 插件（V1 用单数 plugin 键）。只合并
 * 该键，其余内容原样保留；已有配置在 opencode.jsonc 时也写独立 json
 * （两处键不冲突，jsonc 未声明 plugin）。
 */
async function ensurePluginConfigured(): Promise<void> {
  const path = join(OPENCODE_CONFIG_DIR, "opencode.json");
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    // 无配置文件或非法 JSON：新建。
  }
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  if (plugins.includes("opencode-llm-proxy")) return;
  await mkdir(OPENCODE_CONFIG_DIR, { recursive: true });
  config.plugin = [...plugins, "opencode-llm-proxy"];
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** 代理是否已在监听。 */
async function proxyAlive(): Promise<boolean> {
  try {
    await fetchJson(PROXY_HEALTH, HEALTH_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

/** 轮询代理就绪。 */
async function waitProxyReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await proxyAlive()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

let bootstrap: Promise<void> | undefined;

/**
 * 确保代理可用并刷新模型清单（进程级单例：并发调用共享同一次拉起）。
 * 任何一步失败都静默结束——目录回落内置清单，不阻塞宿主启动。
 */
function ensureProxy(): Promise<void> {
  bootstrap ??= (async () => {
    if (await proxyAlive()) {
      await refreshModels();
      return;
    }
    try {
      await ensurePluginInstalled();
      await ensurePluginConfigured();
      spawn(
        opencodeBin(),
        ["serve", "--port", String(OPENCODE_SERVE_PORT)],
        { detached: true, stdio: "ignore" },
      ).unref();
      if (await waitProxyReady(BOOTSTRAP_TIMEOUT_MS)) await refreshModels();
    } catch {
      // 拉起失败（opencode 未装/插件安装失败等）：保持内置清单。
    }
  })();
  return bootstrap;
}

export function createOpencodeAdapter(ctx?: Context): PiAiAdapter {
  const piProvider = {
    ...createProvider({
      id: PROVIDER,
      name: "OpenCode Free",
      baseUrl: PROXY_BASE,
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
      models: modelIds.map(modelOf),
      // 与上游 openAICompletionsApi() 同款：懒加载 completions 实现。
      api: lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions")),
    }),
    // 目录动态读缓存：代理就绪刷新清单后，下一次快照重建即生效（profiles
    // 每次操作新建，PiAiAdapter 快照随之重建）。
    getModels() {
      return modelIds.map(modelOf);
    },
  } as unknown as ReturnType<typeof createProvider>;

  const profile: ResolvedPiAiProviderProfile = {
    provider: PROVIDER,
    displayName: "OpenCode Free",
    streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    retryPolicy: resolveRetryPolicy(RETRY_POLICY, "opencode-free retryPolicy"),
    piProvider:
      piProvider as NonNullable<ResolvedPiAiProviderProfile["piProvider"]>,
    // 每模型默认输出上限：物化为 resolveModel 的 defaultMaxTokens 与请求
    // 默认 cap（不进 Map 则只作用于目录，不作用于请求）。
    configuredMaxTokens: new Map(
      modelIds.map((id) => [id, DEFAULT_MAX_TOKENS]),
    ),
    modelErrors: new Map(),
  };

  return new PiAiAdapter({
    // 每次操作新建 Map：PiAiAdapter 快照按 identity 记忆，新建使快照在
    // 模型清单刷新后重建（清单缓存在模块级，重建无 IO）。
    profiles: () => new Map([[PROVIDER, profile]]),
    // 本地代理无认证；zen 免费档也接受 Bearer public。
    resolveApiKey: async () => "public",
    auth: {
      credentials: new InMemoryCredentialStore(),
      authContext: defaultProviderAuthContext(),
    },
    resolveAttachments: () => ctx?.get("attachments"),
  });
}

/** 注册「OpenCode Free」provider（路由 opencode-free），并后台确保代理可用。 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter([PROVIDER], createOpencodeAdapter(ctx));
  void ensureProxy();
}
