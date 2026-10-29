/** opencode 会话跨 dsh 重启复用：映射落盘、404 重建、探测失败不误删、并发去重。 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/opencode-backend.ts", () => ({
  ensureBackend: async () => undefined,
  backendBaseUrl: () => "http://opencode.test",
  backendAuthHeader: () => "Basic test",
}));

interface ServeState {
  /** 已存在的 opencode 会话。 */
  sessions: Set<string>;
  counter: number;
  /** POST /api/session 的调用次数。 */
  created: number;
  /** 最近一次被操作（切模型/prompt）的会话。 */
  active: string | undefined;
  /** 会话探测的状态码；0 表示按 sessions 返回 200/404。 */
  probeStatus: number;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sse(frames: unknown[]): Response {
  return new Response(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** 一个最小的 opencode v2 serve：建会话、切模型、prompt、SSE 事件流。 */
function mockServe(state: ServeState): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/event") {
        return sse([
          { type: "server.connected", data: {} },
          {
            type: "session.text.delta",
            data: {
              sessionID: state.active,
              assistantMessageID: "msg_1",
              ordinal: 1,
              delta: "ok",
            },
          },
          { type: "session.execution.succeeded", data: { sessionID: state.active } },
        ]);
      }
      if (url.pathname === "/api/session" && method === "POST") {
        state.counter += 1;
        state.created += 1;
        const id = `ses_mock_${state.counter}`;
        state.sessions.add(id);
        return json({ data: { id } });
      }
      const match = /^\/api\/session\/([^/]+)(\/[^/]+)?$/.exec(url.pathname);
      if (match !== null) {
        const [, id, action] = match;
        if (id !== undefined && action === undefined) {
          if (state.probeStatus !== 0) return json({}, state.probeStatus);
          return state.sessions.has(id) ? json({ data: { id } }) : json({}, 404);
        }
        if (id !== undefined && action !== undefined) {
          state.active = id;
          return json({ data: {} });
        }
      }
      return json({}, 404);
    }),
  );
}

/** 跑一轮最小对话；返回文本增量是否到达。 */
async function turn(sessionId: string): Promise<boolean> {
  const { PROVIDER, createOpencodeAdapter } = await import("../src/opencode-provider.ts");
  const adapter = createOpencodeAdapter();
  let sawText = false;
  const options = {
    provider: PROVIDER,
    model: "opencode/deepseek-v4.1-flash-free",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    sessionId,
  } as never;
  for await (const chunk of adapter.stream(options)) {
    if (chunk.type === "text-delta") sawText = true;
  }
  return sawText;
}

let directory: string;
let mapFile: string;
let state: ServeState;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "dsh-opencode-reuse-"));
  mapFile = join(directory, "sessions.json");
  vi.stubEnv("DSH_OPENCODE_SESSION_MAP", mapFile);
  state = { sessions: new Set(), counter: 0, created: 0, active: undefined, probeStatus: 0 };
  mockServe(state);
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  await rm(directory, { recursive: true, force: true });
});

describe("opencode 会话复用", () => {
  it("dsh 重启后按会话 id 接回原来的 opencode 会话", async () => {
    await expect(turn("session-a")).resolves.toBe(true);
    expect(state.created).toBe(1);
    expect(JSON.parse(await readFile(mapFile, "utf8"))).toEqual({
      "session-a": "ses_mock_1",
    });

    // 模拟 dsh 重启：模块重新加载，映射从磁盘读回。
    vi.resetModules();
    await expect(turn("session-a")).resolves.toBe(true);
    expect(state.created).toBe(1);

    // 另一个 dsh 会话才需要新 opencode 会话。
    await expect(turn("session-b")).resolves.toBe(true);
    expect(state.created).toBe(2);
    expect(JSON.parse(await readFile(mapFile, "utf8"))).toEqual({
      "session-a": "ses_mock_1",
      "session-b": "ses_mock_2",
    });
  });

  it("opencode 侧确认删除（404）后重建并更新映射", async () => {
    await turn("session-a");
    state.sessions.delete("ses_mock_1");

    vi.resetModules();
    await turn("session-a");
    expect(state.created).toBe(2);
    expect(JSON.parse(await readFile(mapFile, "utf8"))).toEqual({
      "session-a": "ses_mock_2",
    });
  });

  it("探测超时或 5xx 不丢弃映射，继续复用", async () => {
    await turn("session-a");
    state.probeStatus = 503;

    vi.resetModules();
    await turn("session-a");
    expect(state.created).toBe(1);
  });

  it("同一会话并发请求只新建一个 opencode 会话", async () => {
    await Promise.all([turn("session-a"), turn("session-a")]);
    expect(state.created).toBe(1);
  });
});
