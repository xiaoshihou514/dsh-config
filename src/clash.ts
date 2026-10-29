/**
 * Clash / Mihomo 控制：在 opencode 免费模型限流时切换出口节点。
 *
 * 限流是按下游 IP 计的，换一个出口节点通常就能继续用。这里直接调 Clash
 * 的 external-controller：
 *
 *  - 从 `/connections` 找出 opencode.ai 当前实际走的代理组（例如「主代理」），
 *    避免猜错规则组；
 *  - 优先用组内节点最近一次测速结果（`history`）做延迟排序，结果不新鲜时
 *    再调 `/group/:name/delay` 现场测速；
 *  - 选延迟最低、且不是当前节点、最近没被切过的节点，`PUT /proxies/:group`
 *    切过去。
 *
 * Clash Verge 内核默认只开 unix socket
 * （`/run/clash-verge-service/users/<uid>/verge-mihomo.sock`），也兼容常见的
 * `127.0.0.1:9090`。地址、密钥、代理组都可通过环境变量或插件配置覆盖。
 */

import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_TEST_URL = "https://www.gstatic.com/generate_204";

/** `history` 超过这个年龄就重新测速。 */
const HISTORY_FRESH_MS = 10 * 60_000;
/** 测速结果不足以排序时，才现场测速：至少要有这么多条新鲜结果。 */
const MIN_FRESH_RESULTS = 3;

/** 这些类型的条目是策略组，不是可切换的出口节点。 */
const GROUP_TYPES = new Set([
  "Selector",
  "URLTest",
  "Fallback",
  "LoadBalance",
  "Relay",
]);

/** 这些条目即使不是策略组也不该被当作出口节点。 */
const NON_NODE_TYPES = new Set([
  "Direct",
  "Reject",
  "RejectDrop",
  "Pass",
  "Compatible",
  "Dns",
]);
const NON_NODE_NAMES = new Set([
  "DIRECT",
  "REJECT",
  "REJECT-DROP",
  "PASS",
  "COMPATIBLE",
  "GLOBAL",
]);

export interface ClashOptions {
  /** 总开关；关掉后限流只走普通重试。 */
  enabled: boolean;
  /** external-controller 地址：unix socket 路径或 `http://127.0.0.1:9090`。留空自动探测。 */
  api: string;
  /** external-controller 的 secret；unix socket 通常不需要。 */
  secret: string;
  /** 手动指定代理组；留空按 opencode.ai 的实际连接链自动识别。 */
  group: string;
  /** 延迟测试 URL。 */
  testUrl: string;
  /** 测速超时（ms）。 */
  timeoutMs: number;
  /** 两次自动切换的最小间隔（ms），避免多会话同时触发时限流抖动。 */
  cooldownMs: number;
  /** 最近切换过的节点不再优先选，避免在少数节点间来回弹。 */
  avoidRecent: number;
}

export const DEFAULT_CLASH_OPTIONS: ClashOptions = {
  enabled: true,
  api: "",
  secret: "",
  group: "",
  testUrl: DEFAULT_TEST_URL,
  timeoutMs: 3_000,
  cooldownMs: 3_000,
  avoidRecent: 3,
};

export interface RotationResult {
  group: string;
  from: string;
  to: string;
  delayMs?: number;
}

export interface ClashRotator {
  /** 切换到延迟最低的其他节点；未启用/不可达/找不到组时返回 `undefined`。 */
  rotate(reason?: string): Promise<RotationResult | undefined>;
}

interface ProxyInfo {
  type?: string;
  now?: string;
  all?: string[];
  history?: { time?: string; delay?: number }[];
}

type ProxyMap = Record<string, ProxyInfo>;

type Endpoint = { socketPath: string } | { host: string; port: number };

interface HttpResponse {
  status: number;
  body: string;
}

/** 环境变量覆盖配置（便于临时开关，无需改 profile）。 */
export function resolveClashOptions(
  config: { [K in keyof ClashOptions]?: ClashOptions[K] | undefined } = {},
): ClashOptions {
  const env = process.env;
  const disabled =
    env["DSH_CLASH_DISABLE"] === "1" || env["DSH_CLASH_DISABLE"] === "true";
  const number = (raw: string | undefined, fallback: number): number => {
    const value = Number(raw);
    return raw !== undefined && raw !== "" && Number.isFinite(value)
      ? value
      : fallback;
  };
  const text = (raw: string | undefined, fallback: string): string =>
    raw === undefined || raw.trim() === "" ? fallback : raw.trim();
  return {
    enabled: !disabled && config.enabled !== false,
    api: text(env["DSH_CLASH_API"], config.api ?? DEFAULT_CLASH_OPTIONS.api),
    secret: text(
      env["DSH_CLASH_SECRET"],
      config.secret ?? DEFAULT_CLASH_OPTIONS.secret,
    ),
    group: text(
      env["DSH_CLASH_GROUP"],
      config.group ?? DEFAULT_CLASH_OPTIONS.group,
    ),
    testUrl: text(
      env["DSH_CLASH_TEST_URL"],
      config.testUrl ?? DEFAULT_CLASH_OPTIONS.testUrl,
    ),
    timeoutMs: number(
      env["DSH_CLASH_TIMEOUT_MS"],
      config.timeoutMs ?? DEFAULT_CLASH_OPTIONS.timeoutMs,
    ),
    cooldownMs: number(
      env["DSH_CLASH_COOLDOWN_MS"],
      config.cooldownMs ?? DEFAULT_CLASH_OPTIONS.cooldownMs,
    ),
    avoidRecent: number(
      env["DSH_CLASH_AVOID_RECENT"],
      config.avoidRecent ?? DEFAULT_CLASH_OPTIONS.avoidRecent,
    ),
  };
}

/** 解析配置的 external-controller 地址；留空返回 `undefined`（走自动探测）。 */
export function parseEndpoint(api: string): Endpoint | undefined {
  const value = api.trim();
  if (value === "") return undefined;
  if (value.startsWith("unix:")) {
    const socketPath = value.slice("unix:".length).trim();
    return socketPath === "" ? undefined : { socketPath };
  }
  if (value.startsWith("/")) return { socketPath: value };
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return undefined;
    const port = url.port === "" ? 9090 : Number(url.port);
    if (!Number.isInteger(port) || port <= 0) return undefined;
    return { host: url.hostname === "" ? "127.0.0.1" : url.hostname, port };
  } catch {
    return undefined;
  }
}

/** 自动探测的候选：Clash Verge 的 unix socket，其次常见的 TCP 9090。 */
function defaultEndpoints(): Endpoint[] {
  const uid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  const endpoints: Endpoint[] = [];
  if (uid !== undefined) {
    endpoints.push({
      socketPath: `/run/clash-verge-service/users/${uid}/verge-mihomo.sock`,
    });
  }
  endpoints.push({
    socketPath: join(homedir(), ".config", "clash-verge", "verge-mihomo.sock"),
  });
  endpoints.push({ host: "127.0.0.1", port: 9090 });
  return endpoints;
}

function requestJson(
  endpoint: Endpoint,
  options: ClashOptions,
  path: string,
  method: string = "GET",
  body?: unknown,
): Promise<HttpResponse> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.secret !== "")
    headers["authorization"] = `Bearer ${options.secret}`;
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  const target =
    "socketPath" in endpoint
      ? { socketPath: endpoint.socketPath }
      : { host: endpoint.host, port: endpoint.port };
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { ...target, path, method, headers, timeout: 8_000 },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("timeout", () =>
      request.destroy(new Error("clash api timeout")),
    );
    request.on("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

async function call<T>(
  endpoint: Endpoint,
  options: ClashOptions,
  path: string,
  method: string = "GET",
  body?: unknown,
): Promise<T> {
  const response = await requestJson(endpoint, options, path, method, body);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`clash api ${method} ${path} -> HTTP ${response.status}`);
  }
  if (response.body === "") return undefined as T;
  return JSON.parse(response.body) as T;
}

function isGroup(proxy: ProxyInfo | undefined): boolean {
  return (
    proxy !== undefined &&
    GROUP_TYPES.has(proxy.type ?? "") &&
    Array.isArray(proxy.all)
  );
}

/** 当前规则实际使用的代理组：优先看 opencode.ai 的连接链，再退回常见组名。 */
export async function detectGroup(
  endpoint: Endpoint,
  options: ClashOptions,
  proxies: ProxyMap,
): Promise<string | undefined> {
  try {
    const payload = await call<{
      connections?: { metadata?: { host?: string }; chains?: string[] }[];
    }>(endpoint, options, "/connections");
    const connection = (payload.connections ?? []).find((item) => {
      const host = item.metadata?.host ?? "";
      return host.includes("opencode.ai");
    });
    for (const name of [...(connection?.chains ?? [])].reverse()) {
      if (isGroup(proxies[name])) return name;
    }
  } catch {
    // `/connections` 不可用（旧内核/权限）：继续按组名兜底。
  }
  for (const name of ["主代理", "Proxy", "PROXY", "节点选择"]) {
    if (isGroup(proxies[name])) return name;
  }
  return Object.keys(proxies).find(
    (name) => name !== "GLOBAL" && isGroup(proxies[name]),
  );
}

function leafNodes(proxies: ProxyMap, group: ProxyInfo): string[] {
  const names = group.all ?? [];
  const nodes = names.filter((name) => {
    const proxy = proxies[name];
    if (proxy === undefined || NON_NODE_NAMES.has(name)) return false;
    return (
      !GROUP_TYPES.has(proxy.type ?? "") &&
      !NON_NODE_TYPES.has(proxy.type ?? "")
    );
  });
  if (nodes.length > 0) return nodes;
  // 组里全是嵌套组时，允许切到嵌套组（不理想，但比不切好）。
  return names.filter(
    (name) => proxies[name] !== undefined && !NON_NODE_NAMES.has(name),
  );
}

function historyDelay(
  proxy: ProxyInfo | undefined,
  freshOnly: boolean,
): number | undefined {
  const entry = proxy?.history?.[proxy.history.length - 1];
  if (
    entry === undefined ||
    typeof entry.delay !== "number" ||
    entry.delay <= 0
  )
    return undefined;
  if (!freshOnly) return entry.delay;
  if (typeof entry.time !== "string") return undefined;
  const time = Date.parse(entry.time);
  if (!Number.isFinite(time)) return undefined;
  return Date.now() - time < HISTORY_FRESH_MS ? entry.delay : undefined;
}

/**
 * 在候选节点里按延迟选最快的一个。先用新鲜的 `history`，不够时现场测速，
 * 再不行就用任意历史值兜底。
 */
async function pickFastest(
  endpoint: Endpoint,
  options: ClashOptions,
  proxies: ProxyMap,
  groupName: string,
  group: ProxyInfo,
  candidates: string[],
): Promise<{ name: string; delayMs?: number } | undefined> {
  if (candidates.length === 0) return undefined;
  const delays = new Map<string, number>();
  for (const name of candidates) {
    const delay = historyDelay(proxies[name], true);
    if (delay !== undefined) delays.set(name, delay);
  }
  if (delays.size < Math.min(MIN_FRESH_RESULTS, candidates.length)) {
    try {
      const measured = await call<Record<string, number>>(
        endpoint,
        options,
        `/group/${encodeURIComponent(groupName)}/delay?url=${encodeURIComponent(options.testUrl)}&timeout=${options.timeoutMs}`,
      );
      for (const [name, delay] of Object.entries(measured)) {
        if (typeof delay === "number" && delay > 0) delays.set(name, delay);
      }
    } catch {
      // 测速失败：继续用历史值。
    }
  }
  const ranked = candidates
    .map((name) => ({
      name,
      delayMs: delays.get(name) ?? historyDelay(proxies[name], false),
    }))
    .filter(
      (item): item is { name: string; delayMs: number } =>
        item.delayMs !== undefined,
    )
    .sort((left, right) => left.delayMs - right.delayMs);
  const best = ranked[0];
  if (best !== undefined) return best;
  // 完全没有延迟数据：仍然换一个节点，总比继续用被限流的出口强。
  const fallback = candidates[0];
  return fallback === undefined ? undefined : { name: fallback };
}

export function createClashRotator(
  options: ClashOptions,
  log: (message: string) => void = (message) =>
    console.log(`[dsh-config] ${message}`),
): ClashRotator {
  let endpoint: Endpoint | undefined;
  let inFlight: Promise<RotationResult | undefined> | undefined;
  let lastResult: RotationResult | undefined;
  let lastAt = 0;
  const recent = new Map<string, string[]>();

  async function resolveEndpoint(): Promise<Endpoint | undefined> {
    if (endpoint !== undefined) return endpoint;
    const explicit = parseEndpoint(options.api);
    for (const candidate of explicit === undefined
      ? defaultEndpoints()
      : [explicit]) {
      try {
        await call<unknown>(candidate, options, "/version");
        endpoint = candidate;
        return endpoint;
      } catch {
        // 下一个候选。
      }
    }
    return undefined;
  }

  async function rotateInternal(
    reason: string | undefined,
  ): Promise<RotationResult | undefined> {
    if (!options.enabled) return undefined;
    const now = Date.now();
    if (lastResult !== undefined && now - lastAt < options.cooldownMs)
      return lastResult;

    const target = await resolveEndpoint();
    if (target === undefined) {
      log("clash api unavailable; skip node rotation");
      return undefined;
    }

    let proxies: ProxyMap;
    try {
      const payload = await call<{ proxies?: ProxyMap }>(
        target,
        options,
        "/proxies",
      );
      proxies = payload.proxies ?? {};
    } catch (error) {
      log(`clash: read proxies failed: ${String(error)}`);
      endpoint = undefined;
      return undefined;
    }

    const groupName =
      options.group !== "" && isGroup(proxies[options.group])
        ? options.group
        : await detectGroup(target, options, proxies);
    if (groupName === undefined) {
      log("clash: no proxy group to rotate");
      return undefined;
    }
    const group = proxies[groupName];
    if (group === undefined) return undefined;

    const current = group.now ?? "";
    const nodes = leafNodes(proxies, group);
    const pool = nodes.filter((name) => name !== current);
    const used = recent.get(groupName) ?? [];
    const fresh = pool.filter((name) => !used.includes(name));
    const candidates = fresh.length > 0 ? fresh : pool;
    if (candidates.length === 0) {
      log(`clash: group ${groupName} has no alternative node`);
      return undefined;
    }

    const best = await pickFastest(
      target,
      options,
      proxies,
      groupName,
      group,
      candidates,
    );
    if (best === undefined) return undefined;

    try {
      await call<unknown>(
        target,
        options,
        `/proxies/${encodeURIComponent(groupName)}`,
        "PUT",
        { name: best.name },
      );
    } catch (error) {
      log(
        `clash: switch ${groupName} -> ${best.name} failed: ${String(error)}`,
      );
      return undefined;
    }

    const limit = Math.max(0, Math.trunc(options.avoidRecent));
    const nextUsed = [...used.filter((name) => name !== best.name), best.name];
    recent.set(groupName, limit === 0 ? [] : nextUsed.slice(-limit));

    lastResult = {
      group: groupName,
      from: current,
      to: best.name,
      ...(best.delayMs === undefined ? {} : { delayMs: best.delayMs }),
    };
    lastAt = Date.now();
    const delay = best.delayMs === undefined ? "" : ` (${best.delayMs}ms)`;
    log(
      `clash: ${groupName} ${current === "" ? "?" : current} -> ${best.name}${delay}` +
        (reason === undefined ? "" : ` [${reason}]`),
    );
    return lastResult;
  }

  return {
    rotate(reason?: string): Promise<RotationResult | undefined> {
      inFlight ??= rotateInternal(reason).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}
