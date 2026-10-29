/** opencode 免费模型限流：切换 Clash 节点后自动重发；已输出内容则不重发。 */

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

interface State {
  eventCalls: number;
  prompts: number;
  generateCalls: number;
}

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
          const frames = turns[state.eventCalls] ?? [];
          state.eventCalls += 1;
          return sse([{ type: "server.connected", data: {} }, ...frames]);
        }
        if (url.pathname === "/api/session" && method === "POST") {
          return json({ data: { id: "ses_mock" } });
        }
        if (url.pathname === "/api/session/ses_mock" && method === "GET") {
          return json({ data: { id: "ses_mock" } });
        }
        if (url.pathname === "/api/session/ses_mock/model")
          return json({ data: {} });
        if (url.pathname === "/api/session/ses_mock/prompt") {
          state.prompts += 1;
          return json({ data: {} });
        }
        if (url.pathname === "/api/experimental/generate/text") {
          state.generateCalls += 1;
          return state.generateCalls === 1
            ? json({ message: "Provider request failed with HTTP 429" }, 429)
            : json({ data: { text: "标题" } });
        }
        return json({}, 404);
      },
    ),
  );
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
): Promise<{ text: string; finish: string | undefined; state: State }> {
  const state: State = { eventCalls: 0, prompts: 0, generateCalls: 0 };
  mockServe(state, turns);
  const { PROVIDER, createOpencodeAdapter } =
    await import("../src/opencode-provider.ts");
  const adapter = createOpencodeAdapter(undefined, rotator);
  const options = {
    provider: PROVIDER,
    model: "opencode/deepseek-v4.1-flash-free",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    sessionId: "session-a",
    ...(purpose === undefined ? {} : { purpose }),
  } as never;

  let text = "";
  let finish: string | undefined;
  for await (const chunk of adapter.stream(options)) {
    if (chunk.type === "text-delta") text += chunk.text;
    if (chunk.type === "finish") finish = chunk.reason.kind;
  }
  return { text, finish, state };
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
  it("free-limit 未输出内容时换节点并重发同一轮", async () => {
    const { rotator, reasons } = countingRotator();
    const result = await run(rotator, [
      limitTurn("ses_mock"),
      textTurn("ses_mock"),
    ]);

    expect(result.text).toBe("ok");
    expect(result.finish).toBe("stop");
    expect(result.state.prompts).toBe(2);
    expect(reasons).toHaveLength(1);
  });

  it("已输出内容后不重发，只让下一轮换节点", async () => {
    const { rotator, reasons } = countingRotator();
    const result = await run(rotator, [
      [
        {
          type: "session.text.delta",
          data: {
            sessionID: "ses_mock",
            assistantMessageID: "msg_1",
            ordinal: 1,
            delta: "半句",
          },
        },
        ...limitTurn("ses_mock"),
      ],
    ]);

    expect(result.text).toBe("半句");
    expect(result.finish).toBe("error");
    expect(result.state.prompts).toBe(1);
    await vi.waitFor(() => expect(reasons).toHaveLength(1));
  });

  it("辅助请求 429 也换节点后重试", async () => {
    const { rotator, reasons } = countingRotator();
    const result = await run(rotator, [], "session-title");

    expect(result.text).toBe("标题");
    expect(result.state.generateCalls).toBe(2);
    expect(reasons).toHaveLength(1);
  });
});
