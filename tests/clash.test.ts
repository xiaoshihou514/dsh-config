/** Clash external-controller：组识别、延迟排序与节点切换。 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createClashRotator,
  parseEndpoint,
  resolveClashOptions,
  type ClashOptions,
} from "../src/clash.ts";

interface FakeState {
  now: string;
  proxies: Record<
    string,
    {
      type: string;
      now?: string;
      all?: string[];
      history?: { time: string; delay: number }[];
    }
  >;
  connections: { metadata: { host: string }; chains: string[] }[];
  delays: Record<string, number> | undefined;
  puts: { group: string; name: string; authorization: string | undefined }[];
}

const servers: Server[] = [];

function history(delay: number): { time: string; delay: number }[] {
  return [{ time: new Date().toISOString(), delay }];
}

function fakeClash(state: FakeState): Promise<string> {
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://clash");
      const path = decodeURIComponent(url.pathname);
      const json = (status: number, body?: unknown): void => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(body === undefined ? "" : JSON.stringify(body));
      };
      if (path === "/version")
        return json(200, { meta: true, version: "fake" });
      if (path === "/connections")
        return json(200, { connections: state.connections });
      if (path === "/proxies") {
        const proxies = { ...state.proxies };
        const group = proxies["主代理"];
        if (group !== undefined)
          proxies["主代理"] = { ...group, now: state.now };
        return json(200, { proxies });
      }
      if (path.startsWith("/group/") && path.endsWith("/delay")) {
        return json(200, state.delays ?? {});
      }
      if (path.startsWith("/proxies/") && request.method === "PUT") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            name: string;
          };
          state.puts.push({
            group: path.slice("/proxies/".length),
            name: body.name,
            authorization: request.headers.authorization,
          });
          state.now = body.name;
          json(204);
        });
        return;
      }
      json(404, { message: "not found" });
    },
  );
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function baseState(): FakeState {
  return {
    now: "A",
    connections: [
      { metadata: { host: "api.opencode.ai" }, chains: ["A", "主代理"] },
    ],
    delays: undefined,
    puts: [],
    proxies: {
      主代理: { type: "Selector", all: ["A", "B", "C", "DIRECT"] },
      A: { type: "Vless", history: history(100) },
      B: { type: "Vless", history: history(50) },
      C: { type: "Vless", history: history(200) },
      DIRECT: { type: "Direct", history: history(1) },
    },
  };
}

function options(api: string): ClashOptions {
  return {
    ...resolveClashOptions({ api }),
    cooldownMs: 0,
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
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

describe("clash 控制", () => {
  it("解析地址：unix socket / http / 留空", () => {
    expect(parseEndpoint("/run/x.sock")).toEqual({ socketPath: "/run/x.sock" });
    expect(parseEndpoint("unix:/run/x.sock")).toEqual({
      socketPath: "/run/x.sock",
    });
    expect(parseEndpoint("http://127.0.0.1:9090")).toEqual({
      host: "127.0.0.1",
      port: 9090,
    });
    expect(parseEndpoint("http://127.0.0.1")).toEqual({
      host: "127.0.0.1",
      port: 9090,
    });
    expect(parseEndpoint("")).toBeUndefined();
  });

  it("环境变量可关闭/覆盖配置", () => {
    vi.stubEnv("DSH_CLASH_DISABLE", "1");
    vi.stubEnv("DSH_CLASH_GROUP", "自定义组");
    vi.stubEnv("DSH_CLASH_TIMEOUT_MS", "1234");
    const resolved = resolveClashOptions({ enabled: true, group: "配置组" });
    expect(resolved.enabled).toBe(false);
    expect(resolved.group).toBe("自定义组");
    expect(resolved.timeoutMs).toBe(1234);
  });

  it("按延迟排序选最快节点，并避开最近用过的节点", async () => {
    const state = baseState();
    const api = await fakeClash(state);
    const rotator = createClashRotator(options(api), () => undefined);

    await expect(rotator.rotate("test")).resolves.toMatchObject({
      group: "主代理",
      from: "A",
      to: "B",
      delayMs: 50,
    });
    expect(state.puts.map((put) => put.name)).toEqual(["B"]);

    // 当前 B，B 也在最近列表里：A(100ms) 比 C(200ms) 快，但仍然选 A。
    await expect(rotator.rotate("test")).resolves.toMatchObject({
      from: "B",
      to: "A",
    });
    // 当前 A，最近是 B、A：只剩 C。
    await expect(rotator.rotate("test")).resolves.toMatchObject({
      from: "A",
      to: "C",
    });
    expect(state.now).toBe("C");
  });

  it("历史延迟不新鲜时现场测速", async () => {
    const state = baseState();
    state.proxies["A"] = { type: "Vless", history: [] };
    state.proxies["B"] = { type: "Vless", history: [] };
    state.proxies["C"] = { type: "Vless", history: [] };
    state.delays = { A: 20, B: 80, C: 40 };
    const api = await fakeClash(state);
    const rotator = createClashRotator(options(api), () => undefined);

    await expect(rotator.rotate()).resolves.toMatchObject({
      from: "A",
      to: "C",
      delayMs: 40,
    });
  });

  it("代理组从 opencode.ai 的连接链识别，而不是硬编码组名", async () => {
    const state = baseState();
    state.connections = [
      { metadata: { host: "example.com" }, chains: ["C", "其他组"] },
      { metadata: { host: "api.opencode.ai" }, chains: ["B", "主代理"] },
    ];
    const api = await fakeClash(state);
    const rotator = createClashRotator(options(api), () => undefined);

    await expect(rotator.rotate()).resolves.toMatchObject({
      group: "主代理",
      to: "B",
    });
  });

  it("关闭时不发任何请求", async () => {
    let hits = 0;
    const server = createServer((_request, response) => {
      hits += 1;
      response.writeHead(200);
      response.end("{}");
    });
    servers.push(server);
    const api = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      });
    });

    const rotator = createClashRotator(
      { ...options(api), enabled: false },
      () => undefined,
    );
    await expect(rotator.rotate()).resolves.toBeUndefined();
    expect(hits).toBe(0);
  });

  it("external-controller 不可达时安静跳过", async () => {
    const rotator = createClashRotator(
      options("http://127.0.0.1:1"),
      () => undefined,
    );
    await expect(rotator.rotate()).resolves.toBeUndefined();
  });

  it("带上 secret 请求头", async () => {
    const state = baseState();
    const api = await fakeClash(state);
    const rotator = createClashRotator(
      { ...options(api), secret: "s3cret" },
      () => undefined,
    );
    await rotator.rotate();
    expect(state.puts[0]?.authorization).toBe("Bearer s3cret");
  });
});
