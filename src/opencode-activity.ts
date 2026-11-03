/**
 * 把 opencode 会话里的工具、待办和目标写回 dsh。
 *
 * opencode 在自己的进程里执行工具。若把这些调用编成模型的 tool-call 流，
 * dsh 的 agent loop 会再执行一遍。这里改写会话日志：先用只含工具调用的
 * `assistant/message` 登记生命周期，再写 `tool/call` 与 `tool/result` 做展示。
 * `todo/write` 更新待办面板，`goals` 服务更新目标栏。
 * 目标保持解除自动续跑，避免 dsh 再开一轮去问 opencode。
 */

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import {
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  type GenerateOptions,
} from "@deepseek-ai/dsh-llm";
import type { Session, SessionSeq } from "@deepseek-ai/dsh-session";

const MAX_MIRROR_TEXT = 100_000;
const GOAL_EVENT = "rpc.opencode.goal.changed";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

interface GoalView {
  id: string;
  revision: number;
  objective: string;
  phase: "active" | "paused" | "blocked" | "complete";
  maxGoalRounds: number;
}

interface GoalRef {
  id: string;
  revision: number;
}

interface GoalApi {
  get(agent: unknown): GoalView | undefined;
  create(
    agent: unknown,
    request: { objective: string; maxGoalRounds?: number },
  ): GoalView;
  edit(
    agent: unknown,
    ref: GoalRef,
    request: { objective?: string; maxGoalRounds?: number },
  ): GoalView;
  pause(agent: unknown, ref: GoalRef): GoalView;
  resume(agent: unknown, ref: GoalRef): GoalView;
  complete(agent: unknown, ref: GoalRef): GoalView;
  clear(agent: unknown, ref: GoalRef): unknown;
  disarm?(agent: unknown): GoalView | undefined;
  block?(
    agent: unknown,
    ref: GoalRef,
    reason: { code: string; message: string },
  ): GoalView;
}

export interface ActivityLog {
  openStep(): { turn: number; step: number } | undefined;
  toolCall(input: {
    callId: string;
    name: string;
    arguments: string;
    turn: number;
    step: number;
  }): number;
  toolResult(input: {
    callId: string;
    turn: number;
    step: number;
    text: string;
    isError: boolean;
    errorMessage?: string;
    callSeq: number;
  }): void;
  writeTodos(todos: readonly TodoItem[]): void;
}

export interface OpencodeSink {
  readonly agentId: string;
  readonly agent: unknown;
  readonly goals?: GoalApi;
  readonly log: ActivityLog;
}

export interface OpencodeActivity {
  /** 写入了一张工具卡时返回 true，用来阻止把同一轮再发给 opencode。 */
  observe(event: { type?: string; data?: Record<string, unknown> }): boolean;
  /** 把已经展示、但没有结果的调用收成失败，避免卡片一直停在运行中。 */
  close(): boolean;
}

interface OcGoal {
  id: string;
  objective: string;
  status: "active" | "paused" | "complete";
  reason?: string;
  maxRounds?: number;
}

interface CallState {
  name: string;
  args: string;
  buffer: string;
  argsComplete: boolean;
  argsAuthoritative: boolean;
  seq?: number;
  settled: boolean;
  todos?: TodoItem[];
}

interface HostContext {
  agents?: {
    currentInitiator(): Agent | undefined;
  };
  goals?: GoalApi;
}

const goalLinks = new Map<string, string>();
let warnedMissingAgent = false;

/** 测试隔离：忘掉「dsh 会话 → opencode 目标」的对应关系。 */
export function clearOpencodeGoalLinks(): void {
  goalLinks.clear();
}

export function openOpencodeSink(
  ctx: Context | undefined,
  sessionId: GenerateOptions["sessionId"],
): OpencodeSink | undefined {
  if (ctx === undefined) return undefined;
  try {
    const host = ctx as Context & HostContext;
    const agent = host.agents?.currentInitiator();
    if (agent?.session === undefined) {
      warnMissingAgent();
      return undefined;
    }
    if (sessionId !== undefined && String(agent.id) !== String(sessionId)) {
      warnMissingAgent();
      return undefined;
    }
    return {
      agentId: String(agent.id),
      agent,
      ...optionalGoals(host),
      log: bindLog(agent.session),
    };
  } catch (error: unknown) {
    console.error("[dsh-config] opencode activity sink failed:", error);
    return undefined;
  }
}

export function createOpencodeActivity(
  sink: OpencodeSink | undefined,
  opencodeSessionID: string,
): OpencodeActivity {
  return new Activity(sink, opencodeSessionID);
}

/** 目标服务没就绪时仍写工具卡，不让整次镜像失败。 */
function optionalGoals(host: HostContext): { goals: GoalApi } | Record<string, never> {
  try {
    const goals = host.goals;
    return goals === undefined ? {} : { goals };
  } catch {
    return {};
  }
}

function warnMissingAgent(): void {
  if (warnedMissingAgent) return;
  warnedMissingAgent = true;
  console.error(
    "[dsh-config] opencode 活动无法写入当前会话：没有匹配的 agent，工具卡和目标/待办不会同步",
  );
}

function bindLog(session: Session): ActivityLog {
  return {
    openStep: () => openStep(session),
    toolCall(input) {
      const callId = ToolCallId(input.callId);
      const source = modelSource(session);
      session.append(
        "assistant/message",
        {
          turn: input.turn,
          step: input.step,
          message: createAssistantMessage({
            content: [
              {
                type: "tool-call",
                id: callId,
                name: input.name,
                arguments: input.arguments,
              },
            ],
            source,
          }),
          stream: [],
        },
        { surfaceOp: "append" },
      );
      return Number(
        session.append("tool/call", {
          turn: input.turn,
          step: input.step,
          callId,
          name: input.name,
          arguments: input.arguments,
        }).seq,
      );
    },
    toolResult(input) {
      const message = createToolResultMessage({
        callId: ToolCallId(input.callId),
        content: [{ type: "text", text: input.text }],
        isError: input.isError,
      });
      session.append(
        "tool/result",
        {
          turn: input.turn,
          step: input.step,
          message,
          ...(input.isError
            ? {
                error: {
                  name: "OpenCodeToolError",
                  code: "OPENCODE_TOOL_FAILED",
                  ...(input.errorMessage === undefined
                    ? {}
                    : { reason: input.errorMessage }),
                },
              }
            : {}),
        },
        {
          surfaceOp: "append",
          sourceEventSeqs: [input.callSeq as SessionSeq],
        },
      );
    },
    writeTodos(todos) {
      const append = session.append as unknown as (
        type: "todo/write",
        data: { todos: readonly TodoItem[] },
      ) => unknown;
      append("todo/write", { todos });
    },
  };
}

/** 工具登记要带上当前请求的模型来源；找不到时用占位，避免空来源被拒。 */
function modelSource(session: Session): { provider: string; model: string } {
  const events = session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "request/header") continue;
    const { provider, model } = event.data.header.config;
    if (provider !== "" && model !== "") return { provider, model };
  }
  return { provider: "opencode", model: "opencode" };
}

function openStep(session: Session): { turn: number; step: number } | undefined {
  const events = session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.type === "step/end" || event.type === "turn/end") return undefined;
    if (event.type === "step/start") {
      return { turn: event.data.turn, step: event.data.step };
    }
  }
  return undefined;
}

class Activity implements OpencodeActivity {
  private readonly calls = new Map<string, CallState>();
  private step: { turn: number; step: number } | undefined;
  private lastTodos = "";

  constructor(
    private readonly sink: OpencodeSink | undefined,
    private readonly sessionID: string,
  ) {}

  observe(event: { type?: string; data?: Record<string, unknown> }): boolean {
    if (this.sink === undefined) return false;
    const data = event.data ?? {};
    if (data["sessionID"] !== this.sessionID) return false;
    try {
      switch (event.type) {
        case "session.tool.input.started":
          return this.onStarted(data);
        case "session.tool.input.delta":
          return this.onDelta(data);
        case "session.tool.input.ended":
          return this.onEnded(data);
        case "session.tool.called":
          return this.onCalled(data);
        case "session.tool.success":
          return this.onSuccess(data);
        case "session.tool.failed":
          return this.onFailed(data);
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
          return this.settleOpen("opencode tool did not finish");
        case GOAL_EVENT:
          this.onGoal(data);
          return false;
        default:
          return false;
      }
    } catch (error: unknown) {
      console.error("[dsh-config] opencode mirror failed:", error);
      return false;
    }
  }

  close(): boolean {
    try {
      return this.settleOpen("opencode tool did not finish");
    } catch (error: unknown) {
      console.error("[dsh-config] opencode mirror failed:", error);
      return false;
    }
  }

  private onStarted(data: Record<string, unknown>): boolean {
    const id = callIdOf(data);
    if (id === undefined) return false;
    const call = this.ensure(id);
    if (typeof data["name"] === "string" && data["name"] !== "") {
      call.name = data["name"];
    }
    return false;
  }

  private onDelta(data: Record<string, unknown>): boolean {
    const id = callIdOf(data);
    const delta = data["delta"];
    if (id === undefined || typeof delta !== "string" || delta === "") return false;
    const call = this.ensure(id);
    if (call.argsAuthoritative || call.argsComplete) return false;
    call.buffer += delta;
    call.args = cap(call.buffer);
    return false;
  }

  private onEnded(data: Record<string, unknown>): boolean {
    const id = callIdOf(data);
    const text = data["text"];
    if (id === undefined || typeof text !== "string") return false;
    const call = this.ensure(id);
    if (call.argsAuthoritative) return false;
    call.argsComplete = true;
    call.args = cap(text === "" ? "{}" : text);
    return false;
  }

  private onCalled(data: Record<string, unknown>): boolean {
    const id = callIdOf(data);
    if (id === undefined) return false;
    const call = this.ensure(id);
    if (typeof data["name"] === "string" && data["name"] !== "") call.name = data["name"];
    const text = argumentsFromInput(data["input"]);
    call.argsAuthoritative = true;
    if (text !== undefined) call.args = text;
    this.rememberTodos(call, readTodos(record(data["input"])?.["todos"]));
    return this.open(id, call);
  }

  private onSuccess(data: Record<string, unknown>): boolean {
    const id = callIdOf(data);
    if (id === undefined) return false;
    const call = this.ensure(id);
    const metadata = record(data["metadata"]);
    const fromMeta = metadata === undefined ? undefined : readTodos(metadata["todos"]);
    if (fromMeta !== undefined && isTodoName(call.name)) call.todos = fromMeta;
    const wrote = this.finish(id, call, contentText(data["content"]), false);
    this.publishTodos(call);
    return wrote;
  }

  private onFailed(data: Record<string, unknown>): boolean {
    const id = callIdOf(data);
    if (id === undefined) return false;
    const call = this.ensure(id);
    const message = cap(errorMessage(data["error"]));
    return this.finish(id, call, message, true, message);
  }

  private onGoal(data: Record<string, unknown>): void {
    const goals = this.sink?.goals;
    const agent = this.sink?.agent;
    if (goals === undefined || agent === undefined) return;
    const goal = parseGoal(data);
    if (goal === undefined) return;
    syncGoal(goals, agent, this.sink?.agentId ?? "", goal, goalLinks);
  }

  private ensure(id: string): CallState {
    let call = this.calls.get(id);
    if (call === undefined) {
      call = {
        name: "tool",
        args: "{}",
        buffer: "",
        argsComplete: false,
        argsAuthoritative: false,
        settled: false,
      };
      this.calls.set(id, call);
    }
    return call;
  }

  private rememberTodos(call: CallState, todos: TodoItem[] | undefined): void {
    if (todos !== undefined && isTodoName(call.name)) call.todos = todos;
  }

  private publishTodos(call: CallState): void {
    if (!isTodoName(call.name) || call.todos === undefined || this.sink === undefined) {
      return;
    }
    const encoded = JSON.stringify(call.todos);
    if (encoded === this.lastTodos) return;
    this.sink.log.writeTodos(call.todos);
    this.lastTodos = encoded;
  }

  private shownArgs(call: CallState): string {
    if (isTodoName(call.name) && call.todos !== undefined) {
      return cap(JSON.stringify({ todos: call.todos }));
    }
    return call.args;
  }

  private location(): { turn: number; step: number } | undefined {
    if (this.sink === undefined) return undefined;
    if (this.step === undefined) this.step = this.sink.log.openStep();
    return this.step;
  }

  private open(id: string, call: CallState): boolean {
    if (call.seq !== undefined || this.sink === undefined) return false;
    const where = this.location();
    if (where === undefined) return false;
    call.seq = this.sink.log.toolCall({
      callId: id,
      name: displayName(call.name),
      arguments: this.shownArgs(call),
      turn: where.turn,
      step: where.step,
    });
    return true;
  }

  private finish(
    id: string,
    call: CallState,
    text: string,
    isError: boolean,
    errorMessageText?: string,
  ): boolean {
    if (call.settled) return false;
    const opened = this.open(id, call);
    if (call.seq === undefined || this.sink === undefined) return opened;
    const where = this.location();
    if (where === undefined) return opened;
    const body = cap(text.trim() === "" ? "(no output)" : text);
    this.sink.log.toolResult({
      callId: id,
      turn: where.turn,
      step: where.step,
      text: body,
      isError,
      callSeq: call.seq,
      ...(errorMessageText === undefined ? {} : { errorMessage: cap(errorMessageText) }),
    });
    call.settled = true;
    return true;
  }

  private settleOpen(message: string): boolean {
    let wrote = false;
    for (const [id, call] of this.calls) {
      if (call.seq === undefined || call.settled) continue;
      wrote = this.finish(id, call, message, true, message) || wrote;
    }
    return wrote;
  }
}

function syncGoal(
  goals: GoalApi,
  agent: unknown,
  agentId: string,
  next: OcGoal | null,
  links: Map<string, string>,
): void {
  let current = goals.get(agent);
  if (next === null) {
    if (current !== undefined) goals.clear(agent, refOf(current));
    links.delete(agentId);
    return;
  }
  const linked = links.get(agentId);
  const replace =
    (linked !== undefined && linked !== next.id) ||
    (current?.phase === "complete" && next.status !== "complete");
  if (current === undefined || replace) {
    if (current !== undefined && current.phase !== "complete") {
      goals.clear(agent, refOf(current));
    }
    current = goals.create(agent, createRequest(next));
  } else {
    const edit = editRequest(current, next);
    if (edit !== undefined) current = goals.edit(agent, refOf(current), edit);
  }
  links.set(agentId, next.id);
  current = alignGoal(goals, agent, current, next);
  if (current.phase === "active") goals.disarm?.(agent);
}

function alignGoal(
  goals: GoalApi,
  agent: unknown,
  view: GoalView,
  next: OcGoal,
): GoalView {
  if (next.status === view.phase) return view;
  if (next.status === "active") {
    if (view.phase === "paused" || view.phase === "blocked") {
      return goals.resume(agent, refOf(view));
    }
    return view;
  }
  if (next.status === "paused") {
    if (view.phase !== "active") return view;
    if (next.reason !== undefined && goals.block !== undefined) {
      try {
        return goals.block(agent, refOf(view), {
          code: "opencode-goal",
          message: next.reason,
        });
      } catch {
        // 目标服务拒绝带原因的阻塞时，退回普通暂停。
      }
    }
    return goals.pause(agent, refOf(view));
  }
  if (view.phase !== "complete") return goals.complete(agent, refOf(view));
  return view;
}

function createRequest(goal: OcGoal): { objective: string; maxGoalRounds?: number } {
  return {
    objective: goal.objective,
    ...(isPositiveInt(goal.maxRounds) ? { maxGoalRounds: goal.maxRounds } : {}),
  };
}

function editRequest(
  current: GoalView,
  next: OcGoal,
): { objective?: string; maxGoalRounds?: number } | undefined {
  const request: { objective?: string; maxGoalRounds?: number } = {};
  if (current.objective !== next.objective) request.objective = next.objective;
  if (isPositiveInt(next.maxRounds) && current.maxGoalRounds !== next.maxRounds) {
    request.maxGoalRounds = next.maxRounds;
  }
  if (request.objective === undefined && request.maxGoalRounds === undefined) {
    return undefined;
  }
  return request;
}

function refOf(view: GoalView): GoalRef {
  return { id: view.id, revision: view.revision };
}

function parseGoal(data: Record<string, unknown>): OcGoal | null | undefined {
  if (!Object.hasOwn(data, "goal")) return undefined;
  const goal = data["goal"];
  if (goal === null) return null;
  const body = record(goal);
  if (body === undefined) return undefined;
  const id = body["id"];
  const objective = body["objective"];
  const status = body["status"];
  if (typeof id !== "string" || id === "") return undefined;
  if (typeof objective !== "string" || objective.trim() === "") return undefined;
  if (status !== "active" && status !== "paused" && status !== "complete") {
    return undefined;
  }
  const reason = body["reason"];
  const maxRounds = body["maxRounds"];
  return {
    id,
    objective,
    status,
    ...(typeof reason === "string" && reason.trim() !== "" ? { reason } : {}),
    ...(typeof maxRounds === "number" ? { maxRounds } : {}),
  };
}

function readTodos(value: unknown): TodoItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const todos: TodoItem[] = [];
  for (const item of value) {
    const body = record(item);
    if (body === undefined) continue;
    const content = body["content"];
    const status = body["status"];
    if (typeof content !== "string" || content.trim() === "") continue;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") {
      continue;
    }
    todos.push({ content, status });
  }
  return todos;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    const text = partText(part);
    if (text !== "") parts.push(text);
  }
  return parts.join("\n");
}

function partText(part: unknown): string {
  if (typeof part === "string") return part;
  const body = record(part);
  if (body === undefined) return "";
  if (typeof body["text"] === "string") return body["text"];
  if (typeof body["content"] === "string") return body["content"];
  try {
    return JSON.stringify(body);
  } catch {
    return "";
  }
}

function errorMessage(error: unknown): string {
  if (typeof error === "string" && error !== "") return error;
  const body = record(error);
  if (body === undefined) return "opencode tool failed";
  if (typeof body["message"] === "string" && body["message"] !== "") {
    return body["message"];
  }
  if (typeof body["name"] === "string" && body["name"] !== "") return body["name"];
  return "opencode tool failed";
}

function argumentsFromInput(input: unknown): string | undefined {
  if (typeof input === "string" && input !== "") return cap(input);
  if (input === undefined || input === null) return undefined;
  try {
    const text = JSON.stringify(input);
    if (text === undefined || text === "{}") return undefined;
    return cap(text);
  } catch {
    return undefined;
  }
}

function displayName(name: string): string {
  switch (normalizeToolName(name)) {
    case "todowrite":
      return "todo_write";
    case "webfetch":
      return "web_fetch";
    case "websearch":
      return "web_search";
    default:
      return name;
  }
}

function isTodoName(name: string): boolean {
  return normalizeToolName(name) === "todowrite";
}

function normalizeToolName(name: string): string {
  return name.toLowerCase().replaceAll("-", "").replaceAll("_", "");
}

function isPositiveInt(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function cap(text: string): string {
  if (text.length <= MAX_MIRROR_TEXT) return text;
  return `${text.slice(0, MAX_MIRROR_TEXT)}\n…（已截断）`;
}

function callIdOf(data: Record<string, unknown>): string | undefined {
  const id = data["id"];
  return typeof id === "string" && id !== "" ? id : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
