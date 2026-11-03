/** opencode 工具、待办、目标写回 dsh 会话，且不把工具调用编进模型流。 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import {
  clearOpencodeGoalLinks,
  createOpencodeActivity,
  type ActivityLog,
  type OpencodeSink,
  type TodoItem,
} from "../src/opencode-activity.ts";

vi.mock("../src/opencode-backend.ts", () => ({
  ensureBackend: async () => undefined,
  backendBaseUrl: () => "http://opencode.test",
  backendAuthHeader: () => "Basic test",
}));

interface GoalView {
  id: string;
  revision: number;
  objective: string;
  phase: "active" | "paused" | "blocked" | "complete";
  maxGoalRounds: number;
}

interface GoalCalls {
  calls: string[];
  created: { objective: string; maxGoalRounds?: number }[];
  blocked: string[];
}

function fakeGoals(blockThrows = false): GoalCalls & {
  get(): GoalView | undefined;
  create(
    agent: unknown,
    request: { objective: string; maxGoalRounds?: number },
  ): GoalView;
  edit(
    agent: unknown,
    ref: { id: string; revision: number },
    request: { objective?: string; maxGoalRounds?: number },
  ): GoalView;
  pause(agent: unknown, ref: { id: string; revision: number }): GoalView;
  resume(agent: unknown, ref: { id: string; revision: number }): GoalView;
  complete(agent: unknown, ref: { id: string; revision: number }): GoalView;
  clear(agent: unknown, ref: { id: string; revision: number }): void;
  disarm(): GoalView | undefined;
  block(
    agent: unknown,
    ref: { id: string; revision: number },
    reason: { code: string; message: string },
  ): GoalView;
} {
  let current: GoalView | undefined;
  let nextId = 1;
  const calls: string[] = [];
  const created: { objective: string; maxGoalRounds?: number }[] = [];
  const blocked: string[] = [];
  const bump = (phase: GoalView["phase"]): GoalView => {
    if (current === undefined) throw new Error("missing goal");
    current = { ...current, revision: current.revision + 1, phase };
    return current;
  };
  return {
    calls,
    created,
    blocked,
    get: () => current,
    create(_agent, request) {
      calls.push("create");
      created.push(request);
      if (current !== undefined && current.phase !== "complete") {
        throw new Error("exists");
      }
      current = {
        id: `g${nextId}`,
        revision: 1,
        objective: request.objective,
        phase: "active",
        maxGoalRounds: request.maxGoalRounds ?? 8,
      };
      nextId += 1;
      return current;
    },
    edit(_agent, ref, request) {
      calls.push("edit");
      if (
        current === undefined ||
        current.id !== ref.id ||
        current.revision !== ref.revision
      ) {
        throw new Error("stale");
      }
      current = {
        ...current,
        revision: current.revision + 1,
        objective: request.objective ?? current.objective,
        maxGoalRounds: request.maxGoalRounds ?? current.maxGoalRounds,
      };
      return current;
    },
    pause(_agent, ref) {
      calls.push("pause");
      if (current?.id !== ref.id || current.phase !== "active") throw new Error("pause");
      return bump("paused");
    },
    resume(_agent, ref) {
      calls.push("resume");
      if (
        current?.id !== ref.id ||
        (current.phase !== "paused" && current.phase !== "blocked")
      ) {
        throw new Error("resume");
      }
      return bump("active");
    },
    complete(_agent, ref) {
      calls.push("complete");
      if (current?.id !== ref.id || current.phase === "complete") {
        throw new Error("complete");
      }
      return bump("complete");
    },
    clear(_agent, ref) {
      calls.push("clear");
      if (current?.id !== ref.id) throw new Error("clear");
      current = undefined;
    },
    disarm() {
      calls.push("disarm");
      return current;
    },
    block(_agent, ref, reason) {
      calls.push("block");
      blocked.push(reason.message);
      if (blockThrows) throw new Error("block rejected");
      if (current?.id !== ref.id || current.phase !== "active") throw new Error("block");
      return bump("blocked");
    },
  };
}

interface LogEntry {
  type: string;
  input: unknown;
}

function fakeLog(step: { turn: number; step: number } | null = { turn: 2, step: 4 }): {
  log: ActivityLog;
  entries: LogEntry[];
} {
  const entries: LogEntry[] = [];
  let seq = 0;
  return {
    entries,
    log: {
      openStep: () => step ?? undefined,
      toolCall(input) {
        seq += 1;
        entries.push({ type: "tool/call", input });
        return seq;
      },
      toolResult(input) {
        entries.push({ type: "tool/result", input });
      },
      writeTodos(todos) {
        entries.push({ type: "todo/write", input: todos });
      },
    },
  };
}

function sinkFor(
  log: ActivityLog,
  goals: ReturnType<typeof fakeGoals> | undefined = undefined,
): OpencodeSink {
  return {
    agentId: "session-a",
    agent: { id: "session-a" },
    ...(goals === undefined ? {} : { goals }),
    log,
  };
}

function event(
  type: string,
  data: Record<string, unknown>,
  sessionID = "ses_oc",
): { type: string; data: Record<string, unknown> } {
  return { type, data: { sessionID, ...data } };
}

function goalEvent(
  goal: Record<string, unknown> | null,
): { type: string; data: Record<string, unknown> } {
  return event("rpc.opencode.goal.changed", { goal });
}

beforeEach(() => {
  clearOpencodeGoalLinks();
});

describe("opencode 活动镜像", () => {
  it("把工具调用和结果写成 dsh 工具卡，参数以 called 为准", () => {
    const { log, entries } = fakeLog();
    const activity = createOpencodeActivity(sinkFor(log), "ses_oc");

    activity.observe(
      event("session.tool.input.ended", {
        id: "call_1",
        assistantMessageID: "msg",
        text: "{\"command\":\"stale\"}",
      }),
    );
    activity.observe(
      event("session.tool.input.started", {
        id: "call_1",
        assistantMessageID: "msg",
        name: "bash",
      }),
    );
    expect(
      activity.observe(
        event("session.tool.called", {
          id: "call_1",
          assistantMessageID: "msg",
          input: { command: "ls" },
          executed: true,
        }),
      ),
    ).toBe(true);
    activity.observe(
      event("session.tool.success", {
        id: "call_1",
        assistantMessageID: "msg",
        content: [{ type: "text", text: "a.txt" }],
        executed: true,
      }),
    );

    expect(entries).toEqual([
      {
        type: "tool/call",
        input: {
          callId: "call_1",
          name: "bash",
          arguments: "{\"command\":\"ls\"}",
          turn: 2,
          step: 4,
        },
      },
      {
        type: "tool/result",
        input: {
          callId: "call_1",
          turn: 2,
          step: 4,
          text: "a.txt",
          isError: false,
          callSeq: 1,
        },
      },
    ]);
  });

  it("called 没有参数时保留已经结束的原始输入", () => {
    const { log, entries } = fakeLog();
    const activity = createOpencodeActivity(sinkFor(log), "ses_oc");
    activity.observe(
      event("session.tool.input.started", {
        id: "call_1",
        assistantMessageID: "msg",
        name: "read",
      }),
    );
    activity.observe(
      event("session.tool.input.ended", {
        id: "call_1",
        assistantMessageID: "msg",
        text: "{\"filePath\":\"a.ts\"}",
      }),
    );
    activity.observe(
      event("session.tool.called", {
        id: "call_1",
        assistantMessageID: "msg",
        input: {},
        executed: true,
      }),
    );

    expect(entries[0]).toMatchObject({
      input: { name: "read", arguments: "{\"filePath\":\"a.ts\"}" },
    });
  });

  it("失败的工具记成错误结果，别的会话的事件被忽略", () => {
    const { log, entries } = fakeLog();
    const activity = createOpencodeActivity(sinkFor(log), "ses_oc");
    activity.observe(
      event(
        "session.tool.called",
        { id: "other", assistantMessageID: "msg", input: { command: "rm -rf /" }, name: "bash" },
        "ses_other",
      ),
    );
    activity.observe(
      event("session.tool.input.started", {
        id: "call_1",
        assistantMessageID: "msg",
        name: "read",
      }),
    );
    activity.observe(
      event("session.tool.failed", {
        id: "call_1",
        assistantMessageID: "msg",
        error: { message: "missing file" },
        executed: true,
      }),
    );

    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      type: "tool/result",
      input: { text: "missing file", isError: true, errorMessage: "missing file" },
    });
  });

  it("回合结束时把没有结果的调用收成失败", () => {
    const { log, entries } = fakeLog();
    const activity = createOpencodeActivity(sinkFor(log), "ses_oc");
    activity.observe(
      event("session.tool.called", {
        id: "call_1",
        assistantMessageID: "msg",
        name: "bash",
        input: { command: "sleep 10" },
        executed: true,
      }),
    );
    expect(
      activity.observe(
        event("session.execution.succeeded", { assistantMessageID: "msg" }),
      ),
    ).toBe(true);
    expect(activity.close()).toBe(false);
    expect(entries[1]).toMatchObject({
      type: "tool/result",
      input: { isError: true, text: "opencode tool did not finish" },
    });
  });

  it("todowrite 同步待办面板，并丢掉 cancelled", () => {
    const { log, entries } = fakeLog();
    const activity = createOpencodeActivity(sinkFor(log), "ses_oc");
    const todos = [
      { content: "fix", status: "in_progress", priority: "high" },
      { content: "drop", status: "cancelled", priority: "low" },
      { content: "later", status: "pending", priority: "medium" },
    ];
    activity.observe(
      event("session.tool.input.started", {
        id: "call_2",
        assistantMessageID: "msg",
        name: "todowrite",
      }),
    );
    activity.observe(
      event("session.tool.called", {
        id: "call_2",
        assistantMessageID: "msg",
        input: { todos },
        executed: true,
      }),
    );
    activity.observe(
      event("session.tool.success", {
        id: "call_2",
        assistantMessageID: "msg",
        content: [{ type: "text", text: "Todos updated" }],
        metadata: { todos },
        executed: true,
      }),
    );
    activity.observe(
      event("session.tool.success", {
        id: "call_2",
        assistantMessageID: "msg",
        content: [{ type: "text", text: "Todos updated" }],
        metadata: { todos },
        executed: true,
      }),
    );

    const expected: TodoItem[] = [
      { content: "fix", status: "in_progress" },
      { content: "later", status: "pending" },
    ];
    expect(entries.filter((entry) => entry.type === "todo/write")).toEqual([
      { type: "todo/write", input: expected },
    ]);
    expect(entries[0]).toMatchObject({
      input: {
        name: "todo_write",
        arguments: JSON.stringify({ todos: expected }),
      },
    });
  });

  it("同步目标的创建、暂停原因、完成、替换和解除", () => {
    const goals = fakeGoals();
    const { log } = fakeLog();
    const activity = createOpencodeActivity(sinkFor(log, goals), "ses_oc");
    const base = {
      rounds: 1,
      maxRounds: 4,
      boot: "boot",
      updatedAt: 1,
    };

    activity.observe(
      goalEvent({ id: "goal_1", objective: "ship it", status: "active", ...base }),
    );
    expect(goals.calls).toEqual(["create", "disarm"]);
    expect(goals.created[0]).toEqual({ objective: "ship it", maxGoalRounds: 4 });
    expect(goals.get()?.phase).toBe("active");

    goals.calls.length = 0;
    activity.observe(
      goalEvent({
        id: "goal_1",
        objective: "ship the fix",
        status: "active",
        ...base,
      }),
    );
    expect(goals.calls).toEqual(["edit", "disarm"]);
    expect(goals.get()?.objective).toBe("ship the fix");

    goals.calls.length = 0;
    activity.observe(
      goalEvent({
        id: "goal_1",
        objective: "ship the fix",
        status: "paused",
        reason: "needs a credential",
        ...base,
      }),
    );
    expect(goals.calls).toEqual(["block"]);
    expect(goals.blocked).toEqual(["needs a credential"]);
    expect(goals.get()?.phase).toBe("blocked");

    goals.calls.length = 0;
    activity.observe(
      goalEvent({ id: "goal_1", objective: "ship the fix", status: "active", ...base }),
    );
    expect(goals.calls).toEqual(["resume", "disarm"]);

    goals.calls.length = 0;
    activity.observe(
      goalEvent({ id: "goal_2", objective: "next", status: "complete", ...base }),
    );
    expect(goals.calls).toEqual(["clear", "create", "complete"]);
    expect(goals.get()?.phase).toBe("complete");

    goals.calls.length = 0;
    activity.observe(
      goalEvent({ id: "goal_2", objective: "next", status: "active", ...base }),
    );
    expect(goals.calls).toEqual(["create", "disarm"]);
    expect(goals.get()?.phase).toBe("active");

    goals.calls.length = 0;
    activity.observe(goalEvent(null));
    expect(goals.calls).toEqual(["clear"]);
    expect(goals.get()).toBeUndefined();
  });

  it("阻塞被拒绝时退回暂停，忘记对应关系后沿用现有目标", () => {
    const goals = fakeGoals(true);
    const { log } = fakeLog();
    const activity = createOpencodeActivity(sinkFor(log, goals), "ses_oc");
    activity.observe(
      goalEvent({
        id: "goal_1",
        objective: "ship it",
        status: "paused",
        reason: "stop",
        rounds: 1,
        maxRounds: 4,
        boot: "boot",
        updatedAt: 1,
      }),
    );
    expect(goals.calls).toEqual(["create", "block", "pause"]);
    expect(goals.get()?.phase).toBe("paused");

    goals.calls.length = 0;
    clearOpencodeGoalLinks();
    activity.observe(
      goalEvent({
        id: "goal_1",
        objective: "ship it",
        status: "active",
        rounds: 1,
        maxRounds: 4,
        boot: "boot",
        updatedAt: 2,
      }),
    );
    expect(goals.calls).toEqual(["resume", "disarm"]);
  });

  it("没有打开的步骤时不写工具卡", () => {
    const { log, entries } = fakeLog(null);
    const activity = createOpencodeActivity(sinkFor(log), "ses_oc");
    expect(
      activity.observe(
        event("session.tool.called", {
          id: "call_1",
          assistantMessageID: "msg",
          name: "bash",
          input: { command: "ls" },
          executed: true,
        }),
      ),
    ).toBe(false);
    expect(entries).toEqual([]);
  });
});

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

describe("opencode adapter 活动接线", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-opencode-activity-"));
    vi.stubEnv("DSH_OPENCODE_SESSION_MAP", join(directory, "sessions.json"));
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    await rm(directory, { recursive: true, force: true });
  });

  it("流里展示工具和文本，同步待办与目标，且不产出 tool-call 块", async () => {
    const appended: { type: string; data: Record<string, unknown>; opts?: unknown }[] = [];
    let seq = 0;
    const goals = fakeGoals();
    const session = {
      snapshotEvents: () => [
        { type: "step/start", data: { turn: 3, step: 1 } },
        {
          type: "request/header",
          data: {
            header: {
              config: { provider: "opencode-free", model: "deepseek-v4.1-flash-free" },
            },
          },
        },
      ],
      append(type: string, data: Record<string, unknown>, opts?: unknown) {
        seq += 1;
        appended.push({ type, data, opts });
        return { seq };
      },
    };
    const ctx = {
      agents: {
        currentInitiator: () => ({ id: "session-a", session }),
      },
      goals,
      sessions: {
        get: () => ({ header: { cwd: "/tmp/opencode-activity" } }),
      },
    } as unknown as Context;

    const todos = [
      { content: "fix", status: "in_progress", priority: "high" },
      { content: "drop", status: "cancelled", priority: "low" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        const method = init?.method ?? "GET";
        if (url.pathname === "/api/event") {
          return sse([
            { type: "server.connected", data: {} },
            {
              type: "session.tool.input.started",
              data: {
                sessionID: "ses_mock",
                assistantMessageID: "msg",
                id: "call_bash",
                name: "bash",
              },
            },
            {
              type: "session.tool.called",
              data: {
                sessionID: "ses_mock",
                assistantMessageID: "msg",
                id: "call_bash",
                input: { command: "ls" },
                executed: true,
              },
            },
            {
              type: "session.tool.success",
              data: {
                sessionID: "ses_mock",
                assistantMessageID: "msg",
                id: "call_bash",
                content: [{ type: "text", text: "a.txt" }],
                executed: true,
              },
            },
            {
              type: "session.tool.called",
              data: {
                sessionID: "ses_other",
                assistantMessageID: "msg",
                id: "call_foreign",
                name: "bash",
                input: { command: "whoami" },
                executed: true,
              },
            },
            {
              type: "session.tool.input.started",
              data: {
                sessionID: "ses_mock",
                assistantMessageID: "msg",
                id: "call_todo",
                name: "todowrite",
              },
            },
            {
              type: "session.tool.called",
              data: {
                sessionID: "ses_mock",
                assistantMessageID: "msg",
                id: "call_todo",
                input: { todos },
                executed: true,
              },
            },
            {
              type: "session.tool.success",
              data: {
                sessionID: "ses_mock",
                assistantMessageID: "msg",
                id: "call_todo",
                content: [{ type: "text", text: "Todos updated" }],
                metadata: { todos },
                executed: true,
              },
            },
            {
              type: "rpc.opencode.goal.changed",
              data: {
                sessionID: "ses_mock",
                goal: {
                  id: "goal_1",
                  objective: "ship it",
                  status: "active",
                  rounds: 1,
                  maxRounds: 4,
                  boot: "boot",
                  updatedAt: 1,
                },
              },
            },
            {
              type: "session.text.delta",
              data: {
                sessionID: "ses_mock",
                assistantMessageID: "msg",
                ordinal: 1,
                delta: "ok",
              },
            },
            { type: "session.execution.succeeded", data: { sessionID: "ses_mock" } },
          ]);
        }
        if (url.pathname === "/api/session" && method === "POST") {
          return json({ data: { id: "ses_mock" } });
        }
        if (url.pathname === "/api/session/ses_mock" && method === "GET") {
          return json({ data: { id: "ses_mock" } });
        }
        if (
          url.pathname === "/api/session/ses_mock/model" ||
          url.pathname === "/api/session/ses_mock/prompt"
        ) {
          return json({ data: {} });
        }
        return json({}, 404);
      }),
    );

    const { PROVIDER, createOpencodeAdapter } = await import(
      "../src/opencode-provider.ts"
    );
    const chunks: { type: string; text?: string; reason?: { kind: string } }[] = [];
    for await (const chunk of createOpencodeAdapter(ctx).stream({
      provider: PROVIDER,
      model: "opencode/deepseek-v4.1-flash-free",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      sessionId: "session-a",
    } as never)) {
      if (chunk.type === "text-delta") chunks.push({ type: chunk.type, text: chunk.text });
      else if (chunk.type === "finish") {
        chunks.push({ type: chunk.type, reason: chunk.reason });
      } else chunks.push({ type: chunk.type });
    }

    expect(chunks).toEqual([
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: { kind: "stop" } },
    ]);
    expect(appended.map((entry) => entry.type)).toEqual([
      "assistant/message",
      "tool/call",
      "tool/result",
      "assistant/message",
      "tool/call",
      "tool/result",
      "todo/write",
    ]);
    expect(appended[0]?.data).toMatchObject({
      turn: 3,
      step: 1,
      stream: [],
      message: {
        role: "assistant",
        source: {
          kind: "model",
          provider: "opencode-free",
          model: "deepseek-v4.1-flash-free",
        },
        content: [
          {
            type: "tool-call",
            id: "call_bash",
            name: "bash",
            arguments: "{\"command\":\"ls\"}",
          },
        ],
      },
    });
    expect(appended[0]?.opts).toEqual({ surfaceOp: "append" });
    expect(appended[1]?.data).toMatchObject({
      turn: 3,
      step: 1,
      name: "bash",
      arguments: "{\"command\":\"ls\"}",
    });
    expect(appended[2]?.data["message"]).toMatchObject({
      isError: false,
      content: [{ type: "text", text: "a.txt" }],
    });
    expect(appended[2]?.opts).toMatchObject({
      surfaceOp: "append",
      sourceEventSeqs: [2],
    });
    expect(appended[4]?.data).toMatchObject({ name: "todo_write" });
    expect(appended[6]?.data).toEqual({
      todos: [{ content: "fix", status: "in_progress" }],
    });
    expect(goals.calls).toEqual(["create", "disarm"]);
    expect(goals.created[0]).toEqual({ objective: "ship it", maxGoalRounds: 4 });
  });
});
