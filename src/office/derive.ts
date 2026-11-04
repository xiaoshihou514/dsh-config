/**
 * 会话事件 → 办公室快照的纯推导（无 I/O，可单测）。
 *
 * 两步：{@link digestSession} 把一个会话的自有事件压成摘要（活动流、当前
 * 动作、收到的消息、团队名册与任务）；{@link assembleSnapshot} 把 Lead 与
 * 各成员的摘要拼成 {@link OfficeSnapshot}。
 */

import { roleKindOf, tierOf, vendorOf } from "./classify.ts";
import {
  USER_ID,
  type OfficeActivity,
  type OfficeCurrent,
  type OfficeInteraction,
  type OfficeMember,
  type OfficeSnapshot,
  type OfficeTask,
  type OfficeTurnEnd,
  type ToolCategory,
} from "./types.ts";

/** 推导只依赖事件的这几个字段；data 结构按类型宽松读取。 */
export interface LooseEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data?: unknown | undefined;
}

const ACTIVITY_LIMIT = 60;
const PREVIEW_LENGTH = 90;
const TEXT_LENGTH = 4000;
const DETAIL_LENGTH = 600;

type Dict = Record<string, unknown>;

function dict(value: unknown): Dict {
  return typeof value === "object" && value !== null ? (value as Dict) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function clip(text: string, length: number): string {
  const flat = text.length > length ? `${text.slice(0, length)}…` : text;
  return flat;
}

function oneLine(text: string, length: number): string {
  return clip(text.replace(/\s+/g, " ").trim(), length);
}

/** 内容块数组里的纯文本（忽略推理、图片、工具调用）。 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const part = dict(block);
      return part.type === "text" ? (str(part.text) ?? "") : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function reasoningOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const part = dict(block);
      return part.type === "reasoning" ? (str(part.text) ?? "") : "";
    })
    .join("\n")
    .trim();
}

function parseArgs(raw: unknown): Dict {
  if (typeof raw !== "string") return dict(raw);
  try {
    return dict(JSON.parse(raw));
  } catch {
    return {};
  }
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length === 0 ? path : parts[parts.length - 1]!;
}

/** 工具名 → 大类 + 一句中文描述。 */
export function describeTool(
  name: string,
  rawArgs: unknown,
): { category: ToolCategory; label: string } {
  const args = parseArgs(rawArgs);
  const path = str(args.path) ?? str(args.file_path) ?? str(args.file);
  switch (name) {
    case "bash":
    case "pwsh":
    case "shell":
    case "bash_output":
    case "bash_input": {
      const description = str(args.description);
      const command = str(args.command) ?? "";
      return {
        category: "shell",
        label: description ?? (command ? `$ ${oneLine(command, 60)}` : "运行命令"),
      };
    }
    case "read":
    case "read_file":
    case "view_image":
    case "ls":
    case "list_dir":
      return { category: "read", label: path ? `阅读 ${basename(path)}` : "阅读文件" };
    case "edit":
    case "multi_edit":
    case "write":
    case "write_file":
    case "apply_patch":
      return {
        category: "edit",
        label: path ? `修改 ${basename(path)}` : name === "write" ? "写入文件" : "修改代码",
      };
    case "grep":
    case "glob":
    case "find":
    case "search":
      return {
        category: "search",
        label: `搜索 ${oneLine(str(args.pattern) ?? str(args.query) ?? "", 40)}`.trim(),
      };
    case "web_fetch":
    case "fetch":
      return { category: "web", label: `浏览 ${oneLine(str(args.url) ?? "网页", 50)}` };
    case "web_search":
      return { category: "web", label: `检索 ${oneLine(str(args.query) ?? "", 40)}`.trim() };
    case "spawn_teammate":
      return { category: "team", label: `招募 ${str(args.name) ?? "组员"}` };
    case "send_message":
      return { category: "team", label: `发消息给 ${str(args.target) ?? "组员"}` };
    case "wait_agent":
      return { category: "wait", label: "等待组员进展" };
    case "list_agents":
      return { category: "team", label: "查看成员状态" };
    case "interrupt_agent":
      return { category: "team", label: `打断 ${str(args.target) ?? "组员"}` };
    case "team_task_create":
      return { category: "plan", label: `新建任务 ${oneLine(str(args.subject) ?? "", 30)}`.trim() };
    case "team_task_update":
      return { category: "plan", label: "更新任务" };
    case "team_task_list":
    case "team_task_get":
      return { category: "plan", label: "查看任务板" };
    case "todo_write":
      return { category: "plan", label: "更新待办清单" };
    case "ask_user_question":
      return { category: "team", label: "向你提问" };
    case "job_output":
    case "job_list":
      return { category: "shell", label: "查看后台任务输出" };
    case "job_kill":
      return { category: "shell", label: "停止后台任务" };
    case "workflow":
      return { category: "team", label: "运行工作流" };
    case "subagent":
    case "subagent_fork":
      return { category: "team", label: "派出临时助手" };
    case "skill":
      return { category: "read", label: `查阅技能 ${str(args.name) ?? ""}`.trim() };
    case "get_goal":
    case "create_goal":
    case "update_goal":
      return { category: "plan", label: "整理目标" };
    default:
      return { category: "other", label: name };
  }
}

export interface DigestTeamMember {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly phase: "provisioning" | "active" | "failed";
  readonly error?: string | undefined;
  readonly at: number;
  readonly joinedAt: number;
}

export interface SessionDigest {
  readonly id: string;
  readonly title?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  /** 有已开始未结束的步骤。 */
  readonly open: boolean;
  readonly current?: OfficeCurrent | undefined;
  readonly activity: readonly OfficeActivity[];
  readonly stats: OfficeMember["stats"];
  readonly firstAt?: number | undefined;
  readonly lastActiveAt?: number | undefined;
  /** 最近一轮的结束（之后又开了新一轮则没有）。 */
  readonly lastTurn?: OfficeTurnEnd | undefined;
  /** 本会话收到的交流（to = 本会话）。 */
  readonly received: readonly OfficeInteraction[];
  /** 仅 Lead：团队名册（每个成员最后一次快照）。 */
  readonly team: readonly DigestTeamMember[];
  readonly tasks: readonly (OfficeTask & { ownerId?: string | undefined })[];
  readonly todos: readonly OfficeTask[];
}

interface OpenCall {
  readonly callId: string;
  readonly name: string;
  readonly category: ToolCategory;
  readonly label: string;
  readonly at: number;
}

/**
 * 压缩一个会话的自有事件。
 * @param id - 会话 id。
 * @param events - 会话自有事件（fork 继承的前缀须已剔除）。
 * @param parentId - 子会话的父会话（Lead）id；首条无来源的用户消息视作 Lead 的招募指令。
 */
export function digestSession(
  id: string,
  events: readonly LooseEvent[],
  parentId?: string,
): SessionDigest {
  const activity: (OfficeActivity & { failed?: boolean | undefined })[] = [];
  const callEntries = new Map<string, { failed?: boolean | undefined }>();
  const received: OfficeInteraction[] = [];
  const team = new Map<string, DigestTeamMember>();
  const tasks = new Map<string, OfficeTask & { ownerId?: string | undefined }>();
  let todos: OfficeTask[] = [];
  const openCalls = new Map<string, OpenCall>();
  let title: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let stepOpen = false;
  let stepSince = 0;
  let turns = 0;
  let steps = 0;
  let toolCalls = 0;
  let sent = 0;
  let outputTokens = 0;
  let firstAt: number | undefined;
  let lastActiveAt: number | undefined;
  let lastTurnStart = -Infinity;
  let lastTurn: OfficeTurnEnd | undefined;
  let spawnSeen = false;

  const push = (entry: OfficeActivity) => {
    activity.push(entry);
    if (activity.length > ACTIVITY_LIMIT * 2) activity.splice(0, activity.length - ACTIVITY_LIMIT);
  };

  for (const event of events) {
    const data = dict(event.data);
    firstAt ??= event.time;
    switch (event.type) {
      case "session/title": {
        title = str(data.title) ?? title;
        break;
      }
      case "subagent/descriptor": {
        provider = str(data.agentProvider) ?? provider;
        model = str(data.agentModel) ?? model;
        break;
      }
      case "request/header": {
        const config = dict(dict(data.header).config);
        provider = str(config.provider) || provider;
        model = str(config.model) || model;
        break;
      }
      case "turn/start": {
        turns += 1;
        lastActiveAt = event.time;
        lastTurnStart = event.time;
        break;
      }
      case "turn/end": {
        stepOpen = false;
        openCalls.clear();
        const reason = str(dict(data.reason).kind);
        const ok = reason === "completed" || reason === undefined;
        lastTurn = { at: event.time, ok, ...(ok ? {} : { reason }) };
        push({
          at: event.time,
          kind: reason === "completed" || reason === undefined ? "turn" : "error",
          label: reason === "completed" || reason === undefined ? "本轮完成" : `本轮结束：${reason}`,
        });
        break;
      }
      case "step/start": {
        steps += 1;
        stepOpen = true;
        stepSince = event.time;
        lastActiveAt = event.time;
        break;
      }
      case "step/end": {
        stepOpen = false;
        break;
      }
      case "assistant/message": {
        lastActiveAt = event.time;
        const message = dict(data.message);
        const source = dict(message.source);
        provider = str(source.provider) || provider;
        model = str(source.model) || model;
        const usage = dict(data.usage);
        if (typeof usage.outputTokens === "number") outputTokens += usage.outputTokens;
        const text = textOf(message.content).trim();
        if (text.length > 0) {
          push({
            at: event.time,
            kind: "say",
            label: oneLine(text, PREVIEW_LENGTH),
            detail: clip(text, DETAIL_LENGTH),
          });
        } else {
          const thought = reasoningOf(message.content);
          if (thought.length > 0)
            push({
              at: event.time,
              kind: "think",
              label: oneLine(thought, PREVIEW_LENGTH),
              detail: clip(thought, DETAIL_LENGTH),
            });
        }
        break;
      }
      case "tool/call": {
        lastActiveAt = event.time;
        toolCalls += 1;
        const name = str(data.name) ?? "tool";
        const callId = str(data.callId) ?? `${event.seq}`;
        const { category, label } = describeTool(name, data.arguments);
        if (name === "send_message") sent += 1;
        openCalls.set(callId, { callId, name, category, label, at: event.time });
        const entry: OfficeActivity & { failed?: boolean | undefined } = {
          at: event.time,
          kind: "tool",
          category,
          tool: name,
          label,
        };
        callEntries.set(callId, entry);
        push(entry);
        break;
      }
      case "tool/result": {
        const message = dict(data.message);
        const callId = str(message.toolCallId) ?? str(dict(message.source).callId);
        if (callId !== undefined) {
          openCalls.delete(callId);
          const entry = callEntries.get(callId);
          if (entry !== undefined && message.isError === true) entry.failed = true;
          callEntries.delete(callId);
        }
        break;
      }
      case "user/message": {
        const source = dict(data.source);
        const kind = str(source.kind);
        const text = textOf(data.content);
        if (kind === "agent-message") {
          const sender = str(source.senderSessionId) ?? "";
          const body = text.replace(/^Team message from [^:\n]+:\s*/, "");
          received.push(interaction(event, sender, id, "message", body));
          push({
            at: event.time,
            kind: "receive",
            label: oneLine(body, PREVIEW_LENGTH),
            detail: clip(body, DETAIL_LENGTH),
          });
        } else if (kind === "subagent-settled") {
          const sender = str(source.senderSessionId) ?? "";
          const body = text
            .replace(/^Background subagent \S+ finished[^\n]*\n?/, "")
            .replace(/^Its closing message:\s*/, "");
          received.push(interaction(event, sender, id, "report", body));
        } else if (kind === "user") {
          // 子会话的首条用户消息是 Lead 的招募指令；Lead 收到的是你的指令。
          if (parentId !== undefined && !spawnSeen) {
            spawnSeen = true;
            received.push(interaction(event, parentId, id, "spawn", text));
          } else if (parentId === undefined) {
            received.push(interaction(event, USER_ID, id, "instruction", text));
            push({
              at: event.time,
              kind: "receive",
              label: oneLine(text, PREVIEW_LENGTH),
              detail: clip(text, DETAIL_LENGTH),
            });
          }
        }
        break;
      }
      case "team/member": {
        const member = dict(data.member);
        const memberId = str(member.id);
        const name = str(member.name);
        const phase = str(member.phase);
        if (memberId === undefined || name === undefined) break;
        const prior = team.get(memberId);
        team.set(memberId, {
          id: memberId,
          name,
          description: str(member.description),
          phase: phase === "active" || phase === "failed" ? phase : "provisioning",
          error: str(member.error),
          at: event.time,
          joinedAt: prior?.joinedAt ?? event.time,
        });
        break;
      }
      case "team/task": {
        const task = dict(data.task);
        const taskId = str(task.id);
        const status = str(task.status);
        if (taskId === undefined) break;
        if (status === "deleted") {
          tasks.delete(taskId);
          break;
        }
        tasks.set(taskId, {
          id: taskId,
          subject: str(task.subject) ?? taskId,
          status: status === "in_progress" || status === "completed" ? status : "pending",
          ownerId: str(task.ownerId),
        });
        break;
      }
      case "todo/write": {
        const list = Array.isArray(data.todos) ? data.todos : [];
        todos = list.map((raw, index) => {
          const todo = dict(raw);
          const status = str(todo.status);
          return {
            id: `todo-${index + 1}`,
            subject: str(todo.content) ?? "",
            status: status === "in_progress" || status === "completed" ? status : "pending",
          };
        });
        break;
      }
      default:
        break;
    }
  }

  const trimmed = activity.slice(-ACTIVITY_LIMIT);

  let current: OfficeCurrent | undefined;
  if (stepOpen) {
    const pending = [...openCalls.values()].at(-1);
    if (pending !== undefined) {
      current = {
        kind: pending.category === "wait" ? "waiting" : "tool",
        category: pending.category,
        tool: pending.name,
        label: pending.label,
        since: pending.at,
      };
    } else {
      current = { kind: "thinking", label: "思考中…", since: stepSince };
    }
  }

  return {
    id,
    title,
    provider,
    model,
    open: stepOpen,
    current,
    activity: trimmed,
    stats: {
      turns,
      steps,
      toolCalls,
      sent,
      received: received.length,
      outputTokens,
    },
    firstAt,
    lastActiveAt,
    lastTurn: lastTurn !== undefined && lastTurn.at >= lastTurnStart ? lastTurn : undefined,
    received,
    team: [...team.values()],
    tasks: [...tasks.values()],
    todos,
  };

  function interaction(
    event: LooseEvent,
    from: string,
    to: string,
    kind: OfficeInteraction["kind"],
    text: string,
  ): OfficeInteraction {
    return {
      id: `${to}:${event.seq}`,
      at: event.time,
      from,
      to,
      kind,
      preview: oneLine(text, PREVIEW_LENGTH),
      text: clip(text.trim(), TEXT_LENGTH),
    };
  }
}

/** 运行时补充：会话是否已加载在内存（未加载的成员不可能在跑）。 */
export interface AssembleInput {
  readonly leadId: string;
  readonly lead: SessionDigest;
  readonly cwd?: string | undefined;
  /** 成员 id → 摘要；读不到的成员缺省。 */
  readonly members: ReadonlyMap<string, SessionDigest>;
  readonly loaded: ReadonlySet<string>;
  readonly now: number;
  readonly interactionLimit?: number | undefined;
}

export function assembleSnapshot(input: AssembleInput): OfficeSnapshot {
  const { leadId, lead, members, loaded } = input;
  const names = new Map<string, string>([[leadId, "lead"]]);
  for (const entry of lead.team) names.set(entry.id, entry.name);

  const memberOf = (
    digest: SessionDigest | undefined,
    base: {
      id: string;
      name: string;
      role: "lead" | "teammate";
      description?: string | undefined;
      phase: OfficeMember["phase"];
      error?: string | undefined;
      joinedAt?: number | undefined;
    },
  ): OfficeMember => {
    const busy = digest !== undefined && digest.open && loaded.has(base.id);
    return {
      ...base,
      provider: digest?.provider,
      model: digest?.model,
      vendor: vendorOf(digest?.provider, digest?.model),
      tier: tierOf(digest?.model),
      roleKind: roleKindOf(base.role, base.name, base.description),
      busy,
      current: busy ? digest?.current : undefined,
      lastActiveAt: digest?.lastActiveAt,
      lastTurn: digest?.lastTurn,
      stats: digest?.stats ?? {
        turns: 0,
        steps: 0,
        toolCalls: 0,
        sent: 0,
        received: 0,
        outputTokens: 0,
      },
    };
  };

  const roster: OfficeMember[] = [
    memberOf(lead, {
      id: leadId,
      name: "lead",
      role: "lead",
      description: "项目经理",
      phase: "active",
      joinedAt: lead.firstAt,
    }),
    ...lead.team.map((entry) =>
      memberOf(members.get(entry.id), {
        id: entry.id,
        name: entry.name,
        role: "teammate",
        description: entry.description,
        phase: entry.phase,
        error: entry.error,
        joinedAt: entry.joinedAt,
      }),
    ),
  ];

  const known = new Set(roster.map((member) => member.id));
  const interactions: OfficeInteraction[] = [];
  const collect = (digest: SessionDigest | undefined) => {
    for (const item of digest?.received ?? []) {
      // 只保留团队内部（含你本人）的交流；外部子代理的回报不算。
      if (item.from !== USER_ID && !known.has(item.from)) continue;
      interactions.push(item);
    }
  };
  collect(lead);
  for (const entry of lead.team) collect(members.get(entry.id));
  // 子会话日志里缺少招募记录时（如读取失败），用名册补一条招募。
  for (const entry of lead.team) {
    if (interactions.some((item) => item.to === entry.id && item.kind === "spawn")) continue;
    interactions.push({
      id: `${entry.id}:spawn`,
      at: entry.joinedAt,
      from: leadId,
      to: entry.id,
      kind: "spawn",
      preview: entry.description ?? "加入团队",
      text: entry.description ?? "",
    });
  }
  interactions.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const limit = input.interactionLimit ?? 200;

  let tasks: OfficeTask[];
  let taskSource: OfficeSnapshot["taskSource"];
  if (lead.tasks.length > 0) {
    tasks = lead.tasks.map(({ ownerId, ...task }) => ({
      ...task,
      ownerName: ownerId === undefined ? undefined : (names.get(ownerId) ?? ownerId),
    }));
    taskSource = "team";
  } else if (lead.todos.length > 0) {
    tasks = [...lead.todos];
    taskSource = "todo";
  } else {
    tasks = [];
    taskSource = "none";
  }

  return {
    leadId,
    title: lead.title,
    cwd: input.cwd,
    generatedAt: input.now,
    members: roster,
    interactions: interactions.slice(-limit),
    tasks,
    taskSource,
  };
}
