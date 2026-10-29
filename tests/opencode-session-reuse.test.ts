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
  /** 无会话文本生成端点的调用次数。 */
  generateText: number;
  /** 最近一次无会话生成请求体。 */
  lastGenerateText: Record<string, unknown> | undefined;
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
      if (url.pathname === "/api/experimental/generate/text" && method === "POST") {
        state.generateText += 1;
        state.lastGenerateText = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({ data: { text: "dsh 配置" } });
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

/** 跑一次辅助请求（会话标题/上下文压缩），返回文本增量。 */
async function auxiliary(
  purpose: "session-title" | "compaction",
  messages: unknown[],
  system?: string,
): Promise<string> {
  const { PROVIDER, createOpencodeAdapter } = await import("../src/opencode-provider.ts");
  const adapter = createOpencodeAdapter();
  let text = "";
  const options = {
    provider: PROVIDER,
    model: "opencode/deepseek-v4.1-flash-free",
    messages,
    ...(system === undefined ? {} : { system }),
    purpose,
    sessionId: "session-a",
  } as never;
  for await (const chunk of adapter.stream(options)) {
    if (chunk.type === "text-delta") text += chunk.text;
  }
  return text;
}

let directory: string;
let mapFile: string;
let state: ServeState;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "dsh-opencode-reuse-"));
  mapFile = join(directory, "sessions.json");
  vi.stubEnv("DSH_OPENCODE_SESSION_MAP", mapFile);
  state = {
    sessions: new Set(),
    counter: 0,
    created: 0,
    active: undefined,
    probeStatus: 0,
    generateText: 0,
    lastGenerateText: undefined,
  };
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

  it("标题/压缩等辅助请求走无会话生成，不污染主会话", async () => {
    const text = await auxiliary(
      "session-title",
      [{ role: "user", content: [{ type: "text", text: "熟悉一下 dsh-config" }] }],
      "Create a concise title.",
    );

    expect(text).toBe("dsh 配置");
    expect(state.generateText).toBe(1);
    expect(state.created).toBe(0);
    expect(state.lastGenerateText).toEqual({
      prompt: "Create a concise title.\n\n熟悉一下 dsh-config",
      model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" },
    });
  });

  it("压缩请求保留历史文本并排除 system 消息", async () => {
    await auxiliary("compaction", [
      { role: "system", content: [{ type: "text", text: "你是助手" }] },
      { role: "user", content: [{ type: "text", text: "第一问" }] },
      { role: "assistant", content: [{ type: "text", text: "第一答" }] },
      { role: "user", content: [{ type: "text", text: "请总结" }] },
    ]);

    expect(state.lastGenerateText?.["prompt"]).toBe(
      "用户：第一问\n\n助手：第一答\n\n用户：请总结",
    );
    expect(state.created).toBe(0);
  });
});
