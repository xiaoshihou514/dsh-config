/**
 * OpenCode v2 后端桥：拉起并复用 `opencode serve`（v2 API），供模型 adapter
 * 与可选的 `/opencode/*` 调试代理共用。
 *
 * v2 的 serve 不再提供 v1 的匿名 `/session`、`/event` API，而是：
 *  - API 前缀 `/api`（`/api/session`、`/api/event`、`/api/model`…）；
 *  - HTTP Basic 认证，用户名固定 `opencode`，密码由 serve 生成或由
 *    `OPENCODE_SERVER_PASSWORD` 指定；
 *  - 同一进程同时提供 Web UI，未匹配的路径会回落到 SPA。
 *
 * 为了让 dsh 重启后仍能复用上一次拉起的 serve，密码保存在
 * `~/.cache/dsh-opencode/password`（0600），并在 spawn 时通过
 * `OPENCODE_SERVER_PASSWORD` 传给 serve。若 4097 已被别的服务占用（例如
 * 密码未知的旧 serve），就顺延到 4098、4099…，不杀用户进程。
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-host-webserver";

export const name = "dsh-config-opencode-backend";
export const inject = ["webServer"];

const HOST = "127.0.0.1";
const ROUTE = "/opencode";
const DEFAULT_CANDIDATE_PORTS = [4097, 4098, 4099, 4100, 4101];
const HEALTH_TIMEOUT_MS = 1_500;
const READY_TIMEOUT_MS = 30_000;
const PASSWORD_FILE = join(homedir(), ".cache", "dsh-opencode", "password");

/** hop-by-hop 头不能转发（RFC 7230 §6.1）。 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function opencodeBin(): string {
  const local = join(homedir(), ".opencode", "bin", "opencode");
  return existsSync(local) ? local : "opencode";
}

function origin(port: number): string {
  return `http://${HOST}:${port}`;
}

/** 候选端口；`DSH_OPENCODE_PORTS` 仅供测试注入（逗号分隔）。 */
function candidatePorts(): number[] {
  const raw = process.env.DSH_OPENCODE_PORTS;
  if (raw === undefined || raw === "") return DEFAULT_CANDIDATE_PORTS;
  const parsed = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((port) => Number.isInteger(port) && port > 0);
  return parsed.length === 0 ? DEFAULT_CANDIDATE_PORTS : parsed;
}

let passwordCache: string | undefined;

/** serve 的 Basic 密码：优先环境变量，其次持久化文件，最后生成。 */
export function backendPassword(): string {
  if (passwordCache !== undefined) return passwordCache;
  const fromEnv = process.env.OPENCODE_SERVER_PASSWORD;
  if (fromEnv !== undefined && fromEnv !== "") {
    passwordCache = fromEnv;
    return passwordCache;
  }
  try {
    const saved = readFileSync(PASSWORD_FILE, "utf8").trim();
    if (saved !== "") {
      passwordCache = saved;
      return passwordCache;
    }
  } catch {
    // 首次运行：下面生成。
  }
  const created = randomBytes(32).toString("base64url");
  try {
    mkdirSync(dirname(PASSWORD_FILE), { recursive: true });
    writeFileSync(PASSWORD_FILE, created, { mode: 0o600 });
    chmodSync(PASSWORD_FILE, 0o600);
  } catch {
    // 只读 HOME 等：密码仍在本进程内有效。
  }
  passwordCache = created;
  return passwordCache;
}

export function backendAuthHeader(): string {
  return `Basic ${Buffer.from(`opencode:${backendPassword()}`).toString("base64")}`;
}

let active: { origin: string; port: number } | undefined;

/** 当前后端地址；仅可在 `ensureBackend()` 成功之后调用。 */
export function backendBaseUrl(): string {
  if (active === undefined) throw new Error("opencode backend is not ready");
  return active.origin;
}

type PortState = "ready" | "busy" | "down";

/** `ready`：密码匹配的 v2 serve；`busy`：端口有别的服务；`down`：无人监听。 */
async function probe(port: number): Promise<PortState> {
  try {
    const response = await fetch(`${origin(port)}/api/session?limit=1`, {
      headers: { authorization: backendAuthHeader() },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return response.ok ? "ready" : "busy";
  } catch {
    return "down";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnServer(port: number): void {
  spawn(opencodeBin(), ["serve", "--port", String(port), "--hostname", HOST], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: backendPassword() },
  }).unref();
}

let booting: Promise<void> | undefined;

/**
 * 确保有一个可认证的 v2 serve（进程级单例）：先复用候选端口上密码匹配的
 * 实例，否则从第一个空闲端口拉起。全部失败时抛错，调用方决定如何呈现。
 */
export function ensureBackend(): Promise<void> {
  booting ??= (async () => {
    for (const port of candidatePorts()) {
      const state = await probe(port);
      if (state === "ready") {
        active = { origin: origin(port), port };
        return;
      }
      if (state === "busy") continue;
      spawnServer(port);
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if ((await probe(port)) === "ready") {
          active = { origin: origin(port), port };
          return;
        }
        await sleep(300);
      }
    }
    throw new Error(
      "opencode v2 backend unavailable: install opencode or start `opencode serve`",
    );
  })().catch((error: unknown) => {
    // 允许下一次请求重试（比如用户刚刚安装/启动了 opencode）。
    booting = undefined;
    throw error;
  });
  return booting;
}

function upstreamHeaders(
  headers: IncomingMessage["headers"],
  extra: OutgoingHttpHeaders,
  port: number,
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    // 只代理 opencode 自己的请求；浏览器 cookie/dsh 鉴权头与 serve 无关。
    if (lower === "cookie" || lower === "authorization") continue;
    out[key] = value;
  }
  Object.assign(out, extra);
  out.host = `${HOST}:${port}`;
  return out;
}

function proxyRequest(request: IncomingMessage, response: ServerResponse): void {
  if (active === undefined) {
    response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end("opencode backend unavailable");
    return;
  }
  forwardTo(
    { host: HOST, port: active.port, route: ROUTE, prefix: "/api" },
    request,
    response,
    { authorization: backendAuthHeader() },
  );
}

/**
 * 把 `/opencode/*` 转发到 upstream（导出以便单测真实流式行为）。
 * `prefix` 用于补上 v2 的 `/api`；`extraHeaders` 注入 Basic 认证。
 */
export function forwardTo(
  upstreamTarget: { host: string; port: number; route: string; prefix?: string },
  request: IncomingMessage,
  response: ServerResponse,
  extraHeaders: OutgoingHttpHeaders = {},
): void {
  const url = new URL(request.url ?? "/", "http://x");
  const tail = url.pathname.slice(upstreamTarget.route.length) || "/";
  const path = `${upstreamTarget.prefix ?? ""}${tail}${url.search}`;
  const upstream = httpRequest(
    {
      host: upstreamTarget.host,
      port: upstreamTarget.port,
      method: request.method,
      path,
      headers: upstreamHeaders(request.headers, extraHeaders, upstreamTarget.port),
    },
    (incoming) => {
      const headers: OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue;
        if (HOP_BY_HOP.has(key.toLowerCase())) continue;
        headers[key] = value;
      }
      response.writeHead(incoming.statusCode ?? 502, headers);
      // SSE 必须立刻把响应头交给浏览器，否则 EventSource 会一直等 body。
      response.flushHeaders();
      incoming.pipe(response);
    },
  );

  upstream.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end("opencode backend unavailable");
      return;
    }
    response.destroy();
  });

  // 浏览器关闭面板 / 切走时终止上游长连接（尤其是 /event）。
  response.on("close", () => {
    if (!response.writableEnded) upstream.destroy();
  });

  if (request.method === "GET" || request.method === "HEAD") {
    upstream.end();
  } else {
    request.pipe(upstream);
  }
}

export function apply(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: ROUTE,
        handler: async (request, response) => {
          try {
            await ensureBackend();
          } catch {
            response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
            response.end("opencode backend unavailable");
            return;
          }
          proxyRequest(request, response);
        },
      }),
    "dsh-config: opencode backend proxy",
  );
  void ensureBackend().catch(() => undefined);
}
