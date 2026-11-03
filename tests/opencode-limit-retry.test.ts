/** opencode 免费模型限流：换出口后总结旧内容，改用新会话，避免序号把两次请求串起来。 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClashRotator } from "../src/clash.ts";

vi.mock("../src/opencode-backend.ts", () => ({
  ensureBackend: async () => undefined,
  backendBaseUrl: () => "http://opencode.test",
  backendAuthHeader: () => "Basic test",
}));

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

interface PromptRecord {
  sessionId: string;
  text: string;
  status: number;
}

interface State {
  eventCalls: number;
  prompts: PromptRecord[];
  sessions: string[];
  generateCalls: number;
  generateText: string;
  failGenerateOnce: boolean;
  failPrompts: number;
  messages: unknown[];
  trace: string[];
  lastGeneratePrompt: string;
}

const PRIOR_MESSAGES = [
  { type: "user", content: [{ type: "text", text: "先看 README" }] },
  {
    type: "assistant",
    content: [
      { type: "text", text: "README 说要改测试" },
      { type: "tool", name: "read", input: { filePath: "README.md" }, output: "测试在 tests/" },
    ],
  },
];

/** 第一轮限流失败，第二轮成功；可按需要自定义每一轮的 SSE 帧。 */
function mockServe(state: State, turns: unknown[][]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        const method = init?.method ?? "GET";
        if (url.pathname === "/api/event") {
          const sessionID = state.sessions.at(-1);
          const frames = (turns[state.eventCalls] ?? []).map((frame) =>
            stampSession(frame, sessionID),
          );
          state.eventCalls += 1;
          return sse([{ type: "server.connected", data: {} }, ...frames]);
        }
        if (url.pathname === "/api/session" && method === "POST") {
          state.trace.push("session");
          const id = `ses_${state.sessions.length + 1}`;
          state.sessions.push(id);
          return json({ data: { id } });
        }
        const message = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname);
        if (message !== null && method === "GET") {
          state.trace.push("messages");
          return state.sessions.includes(message[1] ?? "")
            ? json({ data: state.messages })
            : json({}, 404);
        }
        const nested = /^\/api\/session\/([^/]+)\/(model|prompt)$/.exec(url.pathname);
        if (nested !== null) {
          const sessionId = nested[1] ?? "";
          if (!state.sessions.includes(sessionId)) return json({}, 404);
          if (nested[2] === "prompt" && method === "POST") {
            const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
            const status = state.failPrompts > 0 ? 429 : 200;
            if (state.failPrompts > 0) state.failPrompts -= 1;
            state.prompts.push({
              sessionId,
              text: body.text ?? "",
              status,
            });
            state.trace.push(status === 429 ? "prompt-429" : "prompt");
            return status === 429
              ? json({ message: "Provider request failed with HTTP 429" }, 429)
              : json({ data: {} });
          }
          return json({ data: {} });
        }
        const probe = /^\/api\/session\/([^/]+)$/.exec(url.pathname);
        if (probe !== null && method === "GET") {
          return state.sessions.includes(probe[1] ?? "")
            ? json({ data: { id: probe[1] } })
            : json({}, 404);
        }
        if (url.pathname === "/api/experimental/generate/text") {
          state.trace.push("generate");
          state.generateCalls += 1;
          const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
          state.lastGeneratePrompt = body.prompt ?? "";
          if (state.failGenerateOnce && state.generateCalls === 1) {
            return json({ message: "Provider request failed with HTTP 429" }, 429);
          }
          return json({ data: { text: state.generateText } });
        }
        return json({}, 404);
      },
    ),
  );
}

function stampSession(frame: unknown, sessionID: string | undefined): unknown {
  if (sessionID === undefined || frame === null || typeof frame !== "object") return frame;
  const record = frame as { data?: Record<string, unknown> };
  if (record.data === undefined || !("sessionID" in record.data)) return frame;
  return { ...record, data: { ...record.data, sessionID } };
}

function textTurn(sessionID: string): unknown[] {
  return [
    {
      type: "session.text.delta",
      data: { sessionID, assistantMessageID: "msg_1", ordinal: 1, delta: "ok" },
    },
    { type: "session.execution.succeeded", data: { sessionID } },
  ];
}

function limitTurn(sessionID: string): unknown[] {
  return [
    {
      type: "session.execution.failed",
      data: {
        sessionID,
        error: {
          type: "provider.free-limit",
          message: "Free usage limit reached",
          retryAfterMs: 16_080_000,
        },
      },
    },
  ];
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "dsh-opencode-limit-"));
  vi.stubEnv("DSH_OPENCODE_SESSION_MAP", join(directory, "sessions.json"));
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  await rm(directory, { recursive: true, force: true });
});

async function run(
  rotator: ClashRotator,
  turns: unknown[][],
  purpose?: "session-title",
  extra: Partial<State> = {},
): Promise<{ text: string; finish: string | undefined; state: State; adapter: {
  stream(options: unknown): AsyncIterable<{ type: string; text?: string; reason?: { kind: string } }>;
} }> {
  const state: State = {
    eventCalls: 0,
    prompts: [],
    sessions: [],
    generateCalls: 0,
    generateText: purpose === "session-title" ? "标题" : "摘要：继续改测试",
    failGenerateOnce: purpose === "session-title",
    failPrompts: 0,
    messages: PRIOR_MESSAGES,
    trace: [],
    lastGeneratePrompt: "",
    ...extra,
  };
  mockServe(state, turns);
  const tracingRotator: ClashRotator = {
    rotate: async (reason) => {
      state.trace.push("rotate");
      return rotator.rotate(reason);
    },
  };
  const { PROVIDER, createOpencodeAdapter } =
    await import("../src/opencode-provider.ts");
  const adapter = createOpencodeAdapter(undefined, tracingRotator);
  const outcome = await collect(adapter, "hi", purpose);
  return { ...outcome, state, adapter };
}

async function collect(
  adapter: {
    stream(options: unknown): AsyncIterable<{ type: string; text?: string; reason?: { kind: string } }>;
  },
  userText: string,
  purpose?: "session-title",
): Promise<{ text: string; finish: string | undefined }> {
  const { PROVIDER } = await import("../src/opencode-provider.ts");
  let text = "";
  let finish: string | undefined;
  for await (const chunk of adapter.stream({
    provider: PROVIDER,
    model: "opencode/deepseek-v4.1-flash-free",
    messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
    sessionId: "session-a",
    ...(purpose === undefined ? {} : { purpose }),
  })) {
    if (chunk.type === "text-delta" && chunk.text !== undefined) text += chunk.text;
    if (chunk.type === "finish") finish = chunk.reason?.kind;
  }
  return { text, finish };
}

function countingRotator(): { rotator: ClashRotator; reasons: string[] } {
  const reasons: string[] = [];
  return {
    reasons,
    rotator: {
      rotate: async (reason?: string) => {
        reasons.push(reason ?? "");
        return { group: "主代理", from: "A", to: "B" };
      },
    },
  };
}

describe("opencode 限流自动换节点", () => {
  it("未满三次 429 时留在原节点和原会话", async () => {
    const { rotator, reasons } = countingRotator();
    const result = await run(rotator, [
      limitTurn("old"),
      limitTurn("old"),
      textTurn("new"),
    ]);
    const accepted = result.state.prompts.filter((prompt) => prompt.status === 200);

    expect(result.text).toBe("ok");
    expect(result.finish).toBe("stop");
    expect(reasons).toEqual([]);
    expect(result.state.sessions).toEqual(["ses_1"]);
    expect(accepted).toHaveLength(3);
    expect(accepted.every((prompt) => prompt.sessionId === "ses_1")).toBe(true);
  });

  it("连续三次 429 后换出口、总结旧会话，再用新会话重发", async () => {
    const { rotator, reasons } = countingRotator();
    const result = await run(rotator, [
      limitTurn("old"),
      limitTurn("old"),
      limitTurn("old"),
      textTurn("new"),
    ]);
    const accepted = result.state.prompts.filter((prompt) => prompt.status === 200);

    expect(result.text).toBe("ok");
    expect(result.finish).toBe("stop");
    expect(accepted).toHaveLength(4);
    expect(accepted.slice(0, 3).every((prompt) => prompt.sessionId === "ses_1")).toBe(true);
    expect(accepted[0]?.text).toBe("hi");
    expect(accepted[3]?.sessionId).toBe("ses_2");
    expect(accepted[3]?.text).toContain("摘要：继续改测试");
    expect(accepted[3]?.text).toContain("[当前用户消息]\nhi");
    expect(accepted[3]?.text).not.toContain("ses_");
    expect(result.state.lastGeneratePrompt).toContain("README");
    expect(result.state.lastGeneratePrompt).not.toContain("ses_");
    expect(result.state.trace.indexOf("rotate")).toBeLessThan(
      result.state.trace.indexOf("generate"),
    );
    expect(reasons).toEqual(["execution limit"]);
  });

  it("prompt 本身连续三次 429 时也换会话再发", async () => {
    const { rotator, reasons } = countingRotator();
    const result = await run(rotator, [[], [], [], textTurn("new")], undefined, {
      failPrompts: 3,
    });
    const accepted = result.state.prompts.filter((prompt) => prompt.status === 200);

    expect(result.text).toBe("ok");
    expect(reasons).toEqual(["prompt 429"]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.sessionId).toBe("ses_2");
    expect(accepted[0]?.text).toContain("摘要：继续改测试");
    expect(result.state.prompts.slice(0, 3).map((prompt) => prompt.status)).toEqual([
      429, 429, 429,
    ]);
    expect(result.state.prompts[0]?.sessionId).toBe("ses_1");
  });

  it("已经输出的内容不重发，摘要留给下一条用户消息", async () => {
    const { rotator, reasons } = countingRotator();
    const result = await run(rotator, [
      [
        {
          type: "session.text.delta",
          data: {
            sessionID: "old",
            assistantMessageID: "msg_1",
            ordinal: 1,
            delta: "半句",
          },
        },
        ...limitTurn("old"),
      ],
      textTurn("new"),
    ]);

    expect(result.text).toBe("半句");
    expect(result.finish).toBe("error");
    expect(result.state.prompts).toHaveLength(1);
    expect(result.state.sessions).toEqual(["ses_1"]);
    expect(reasons).toEqual([]);

    const next = await collect(result.adapter, "下一步");
    const handed = result.state.prompts.at(-1);
    expect(next).toEqual({ text: "ok", finish: "stop" });
    expect(handed?.sessionId).toBe("ses_1");
    expect(handed?.text).toBe("下一步");
    expect(result.state.sessions).toEqual(["ses_1"]);
  });

  it("opencode 自己连续三次要重试时改由新会话接手", async () => {
    const { rotator, reasons } = countingRotator();
    const retry = {
      type: "session.retry.scheduled",
      data: {
        sessionID: "old",
        error: { type: "provider.rate-limit", message: "429" },
      },
    };
    const result = await run(rotator, [
      [retry],
      [retry],
      [retry],
      textTurn("new"),
    ]);

    expect(result.text).toBe("ok");
    expect(reasons).toEqual(["opencode retry"]);
    expect(result.state.prompts.map((prompt) => prompt.sessionId)).toEqual([
      "ses_1",
      "ses_1",
      "ses_1",
      "ses_2",
    ]);
    expect(result.state.prompts[3]?.text).toContain("摘要：继续改测试");
  });

  it("辅助请求 429 也换节点后重试", async () => {
    const { rotator, reasons } = countingRotator();
    const result = await run(rotator, [], "session-title");

    expect(result.text).toBe("标题");
    expect(result.state.generateCalls).toBe(2);
    expect(reasons).toHaveLength(1);
    expect(result.state.sessions).toEqual([]);
  });
});
