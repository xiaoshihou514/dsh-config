/**
 * OpenCode 会话/agent 后端桥：把 opencode 的 HTTP API（session、message、
 * SSE 事件、permission）原样接到 dsh 的同源 Web 服务下。
 *
 * opencode 的网页端与 `opencode serve` 共用同一套 OpenAPI 接口：会话创建、
 * 消息发送（含工具执行与权限请求）、`/event` SSE 流。dsh 浏览器端因此只需
 * 一个同源 `/opencode/*` 反向代理，不必处理 CORS、端口发现或鉴权头。
 *
 * 后端进程策略：
 *  1. 4097 已在监听且是 opencode（/global/health 返回 healthy）→ 直接复用；
 *  2. 未监听 → detached 拉起 `opencode serve --port 4097`，stdio 全弃；
 *  3. 就绪前到达的代理请求会等待拉起完成，避免面板首屏拿到 502。
 *
 * 端口写死 4097：与 opencode-llm-proxy 的 4010 分开。后者由 TUI 运行时
 * 承载（见 ./opencode-provider.ts），serve 模式不会加载它的 server hook。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-host-webserver";

export const name = "dsh-config-opencode-backend";
export const inject = ["webServer"];

const HOST = "127.0.0.1";
const PORT = 4097;
const ROUTE = "/opencode";
const HEALTH_TIMEOUT_MS = 1_500;
const READY_TIMEOUT_MS = 30_000;

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

function baseUrl(): string {
  return `http://${HOST}:${PORT}`;
}

async function healthy(): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl()}/global/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let booting: Promise<void> | undefined;

/**
 * 确保 4097 上有一个可用的 opencode server（进程级单例）。
 * 失败静默结束：代理请求会得到 502，而不是阻塞 dsh 启动。
 */
export function ensureBackend(): Promise<void> {
  booting ??= (async () => {
    if (await healthy()) return;
    spawn(
      opencodeBin(),
      ["serve", "--port", String(PORT), "--hostname", HOST],
      { detached: true, stdio: "ignore" },
    ).unref();
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await healthy()) return;
      await sleep(500);
    }
  })().catch(() => {
    // opencode 未安装或拉起失败：保留 502 让面板显示可诊断的错误。
  });
  return booting;
}

function upstreamHeaders(headers: IncomingMessage["headers"]): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    // 只代理 opencode 自己的请求；浏览器 cookie 与 dsh 鉴权无关。
    if (key.toLowerCase() === "cookie") continue;
    out[key] = value;
  }
  out.host = `${HOST}:${PORT}`;
  return out;
}

function proxyRequest(request: IncomingMessage, response: ServerResponse): void {
  forwardTo({ host: HOST, port: PORT, route: ROUTE }, request, response);
}

/** 把 `/opencode/*` 请求转发到 upstream（导出以便单测真实流式行为）。 */
export function forwardTo(
  upstreamTarget: { host: string; port: number; route: string },
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const url = new URL(request.url ?? "/", "http://x");
  const path = `${url.pathname.slice(upstreamTarget.route.length) || "/"}${url.search}`;
  const upstream = httpRequest(
    {
      host: upstreamTarget.host,
      port: upstreamTarget.port,
      method: request.method,
      path,
      headers: upstreamHeaders(request.headers),
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
          await ensureBackend();
          proxyRequest(request, response);
        },
      }),
    "dsh-config: opencode backend proxy",
  );
  void ensureBackend();
}
