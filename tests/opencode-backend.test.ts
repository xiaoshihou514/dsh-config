/** `/opencode/*` 反向代理：路径去前缀、POST 透传、SSE 不缓冲。 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { forwardTo } from "../src/opencode-backend.ts";

const servers: Server[] = [];

function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function proxyTo(port: number): Promise<number> {
  return listen((request, response) => {
    forwardTo({ host: "127.0.0.1", port, route: "/opencode" }, request, response);
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

describe("opencode 代理", () => {
  it("去掉 /opencode 前缀并保留 query", async () => {
    const upstream = await listen((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ url: request.url }));
    });
    const proxy = await proxyTo(upstream);

    const response = await fetch(`http://127.0.0.1:${proxy}/opencode/session?limit=5`);
    await expect(response.json()).resolves.toEqual({ url: "/session?limit=5" });
  });

  it("POST body 与 content-type 透传到上游", async () => {
    const upstream = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            method: request.method,
            type: request.headers["content-type"],
            body: Buffer.concat(chunks).toString(),
          }),
        );
      });
    });
    const proxy = await proxyTo(upstream);

    const response = await fetch(`http://127.0.0.1:${proxy}/opencode/session/s1/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "hi" }] }),
    });
    await expect(response.json()).resolves.toEqual({
      method: "POST",
      type: "application/json",
      body: JSON.stringify({ parts: [{ type: "text", text: "hi" }] }),
    });
  });

  it("SSE 首帧在连接保持时立即到达客户端", async () => {
    const upstream = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      response.write('data: {"type":"server.connected"}\n\n');
    });
    const proxy = await proxyTo(upstream);

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${proxy}/opencode/event`, {
      signal: controller.signal,
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("server.connected");
    controller.abort();
  });
});
