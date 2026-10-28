/**
 * OpenCode 面板：把 opencode 网页端的那套会话/agent 能力接进 dsh。
 *
 * 数据全部来自同源 `/opencode/*`（见 ../opencode-backend.ts）：
 *  - `GET /opencode/session` 会话列表
 *  - `GET /opencode/session/:id/message` 历史消息
 *  - `POST /opencode/session/:id/prompt_async` 发送（工具在 opencode 侧执行）
 *  - `GET /opencode/event` SSE（消息增量、工具状态、权限请求、忙闲）
 *  - `POST /opencode/permission/:id/reply` 权限应答
 *
 * 不碰 dsh 自己的 Session/Agent：这是一个与 dsh 会话并列的完整 opencode
 * 客户端，因此 opencode 的工具、权限、子会话和持久化都保持原样。
 */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { createPortal } from "react-dom";

interface SessionInfo {
  id: string;
  title?: string;
  directory?: string;
  time?: { created?: number; updated?: number };
  model?: { id?: string; providerID?: string };
}

interface ToolState {
  status?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  title?: string;
}

interface Part {
  id: string;
  messageID: string;
  type: string;
  text?: string;
  tool?: string;
  state?: ToolState;
  [key: string]: unknown;
}

interface Message {
  info: { id: string; sessionID: string; role: string };
  parts: Part[];
}

interface Permission {
  id: string;
  sessionID: string;
  permission: string;
  patterns?: string[];
}

interface ServerEvent {
  type: string;
  properties?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

const MONO: CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };

function textOf(message: Message): string {
  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function timeLabel(session: SessionInfo): string {
  const ms = session.time?.updated ?? session.time?.created;
  if (ms === undefined) return "";
  return new Date(ms).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function mergeMessage(list: Message[], info: Message["info"]): Message[] {
  const at = list.findIndex((message) => message.info.id === info.id);
  if (at === -1) return [...list, { info, parts: [] }];
  const next = [...list];
  next[at] = { ...next[at]!, info };
  return next;
}

function mergePart(list: Message[], part: Part): Message[] {
  const at = list.findIndex((message) => message.info.id === part.messageID);
  const target =
    at === -1
      ? { info: { id: part.messageID, sessionID: part["sessionID"] as string, role: "assistant" }, parts: [] as Part[] }
      : list[at]!;
  const partAt = target.parts.findIndex((existing) => existing.id === part.id);
  const parts =
    partAt === -1
      ? [...target.parts, part]
      : target.parts.map((existing, index) => (index === partAt ? part : existing));
  if (at === -1) return [...list, { ...target, parts }];
  const next = [...list];
  next[at] = { ...target, parts };
  return next;
}

function appendDelta(list: Message[], partID: string, field: string, delta: string): Message[] {
  return list.map((message) => {
    const at = message.parts.findIndex((part) => part.id === partID);
    if (at === -1) return message;
    const parts = [...message.parts];
    const part = { ...parts[at]! };
    const current = part[field];
    part[field] = `${typeof current === "string" ? current : ""}${delta}`;
    parts[at] = part;
    return { ...message, parts };
  });
}

function toolSummary(state: ToolState | undefined): string {
  const input = state?.input;
  if (input === undefined) return "";
  for (const key of ["description", "command", "filePath", "path", "pattern", "query"]) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

function ToolRow({ part }: { part: Part }) {
  const state = part.state;
  const status = state?.status ?? "pending";
  const summary = toolSummary(state);
  const [open, setOpen] = useState(false);
  const detail = state?.output ?? state?.error;
  return (
    <div style={toolCard}>
      <button type="button" style={toolHead} onClick={() => setOpen((value) => !value)}>
        <span style={{ color: "var(--dsw-alias-label-secondary)" }}>{part.tool ?? "tool"}</span>
        <span style={{ marginLeft: "auto", color: status === "error" ? "var(--dsw-alias-label-error)" : "var(--dsw-alias-label-tertiary)" }}>
          {status}
        </span>
      </button>
      {summary !== "" && <div style={toolSummaryStyle}>{summary}</div>}
      {open && detail !== undefined && detail !== "" && (
        <pre style={toolDetail}>{detail.slice(0, 20_000)}</pre>
      )}
    </div>
  );
}

function AssistantParts({ message }: { message: Message }) {
  return (
    <>
      {message.parts.map((part) => {
        if (part.type === "text") {
          if (part.text === undefined || part.text === "") return null;
          return <div key={part.id} style={textBlock}>{part.text}</div>;
        }
        if (part.type === "reasoning") {
          if (part.text === undefined || part.text === "") return null;
          return (
            <details key={part.id} style={reasoningBlock}>
              <summary style={reasoningSummary}>思考</summary>
              <pre style={reasoningText}>{part.text}</pre>
            </details>
          );
        }
        if (part.type === "tool") return <ToolRow key={part.id} part={part} />;
        return null;
      })}
    </>
  );
}

function Conversation({ messages, busy }: { messages: Message[]; busy: boolean }) {
  return (
    <>
      {messages.map((message) => {
        if (message.info.role === "user") {
          const text = textOf(message);
          if (text === "") return null;
          return (
            <div key={message.info.id} style={userRow}>
              <div style={userBubble}>{text}</div>
            </div>
          );
        }
        if (message.info.role !== "assistant") return null;
        return (
          <div key={message.info.id} style={assistantRow}>
            <AssistantParts message={message} />
          </div>
        );
      })}
      {busy && <div style={running}>opencode 正在运行…</div>}
    </>
  );
}

function PermissionBar({
  permissions,
  onReply,
}: {
  permissions: Permission[];
  onReply: (permission: Permission, reply: "once" | "always" | "reject") => void;
}) {
  const permission = permissions[0];
  if (permission === undefined) return null;
  return (
    <div style={permissionBar}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>需要权限：{permission.permission}</div>
        {permission.patterns !== undefined && permission.patterns.length > 0 && (
          <div style={{ ...MONO, fontSize: 12, opacity: 0.8, overflowWrap: "anywhere" }}>
            {permission.patterns.join(", ")}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, flex: "none" }}>
        <button type="button" style={permitButton} onClick={() => onReply(permission, "once")}>仅本次</button>
        <button type="button" style={permitButton} onClick={() => onReply(permission, "always")}>总是</button>
        <button type="button" style={rejectButton} onClick={() => onReply(permission, "reject")}>拒绝</button>
      </div>
    </div>
  );
}

export function OpencodePanel({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [active, setActive] = useState<string>();
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    fetch("/opencode/session?limit=100")
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as SessionInfo[];
      })
      .then((list) => {
        if (!alive) return;
        setSessions(list);
        setActive((current) => current ?? list[0]?.id);
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : "加载会话失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const source = new EventSource("/opencode/event");
    source.onmessage = (event: MessageEvent<string>) => {
      let parsed: ServerEvent;
      try {
        parsed = JSON.parse(event.data) as ServerEvent;
      } catch {
        return;
      }
      const payload = parsed.properties ?? parsed.data ?? {};
      switch (parsed.type) {
        case "message.updated": {
          const info = payload["info"] as Message["info"] | undefined;
          const sid = (payload["sessionID"] as string | undefined) ?? info?.sessionID;
          if (info === undefined || sid === undefined) return;
          setMessages((prev) => ({ ...prev, [sid]: mergeMessage(prev[sid] ?? [], info) }));
          return;
        }
        case "message.part.updated": {
          const part = payload["part"] as Part | undefined;
          if (part === undefined) return;
          const sid = (payload["sessionID"] as string | undefined) ?? (part["sessionID"] as string);
          setMessages((prev) => ({ ...prev, [sid]: mergePart(prev[sid] ?? [], part) }));
          return;
        }
        case "message.part.delta": {
          const sid = payload["sessionID"] as string | undefined;
          const partID = payload["partID"] as string | undefined;
          const field = payload["field"] as string | undefined;
          const delta = payload["delta"] as string | undefined;
          if (sid === undefined || partID === undefined || field === undefined || delta === undefined) return;
          setMessages((prev) => {
            const list = prev[sid];
            if (list === undefined) return prev;
            return { ...prev, [sid]: appendDelta(list, partID, field, delta) };
          });
          return;
        }
        case "session.updated": {
          const info = payload["info"] as SessionInfo | undefined;
          if (info === undefined) return;
          setSessions((prev) => {
            const at = prev.findIndex((item) => item.id === info.id);
            if (at === -1) return [info, ...prev];
            const next = [...prev];
            next[at] = info;
            return next;
          });
          return;
        }
        case "session.status": {
          const sid = payload["sessionID"] as string | undefined;
          const status = payload["status"] as { type?: string } | undefined;
          if (sid === undefined) return;
          setBusy((prev) => ({ ...prev, [sid]: status?.type === "busy" }));
          return;
        }
        case "session.idle": {
          const sid = payload["sessionID"] as string | undefined;
          if (sid === undefined) return;
          setBusy((prev) => ({ ...prev, [sid]: false }));
          return;
        }
        case "permission.asked": {
          const request = payload as unknown as Permission;
          if (request.id === undefined) return;
          setPermissions((prev) => (prev.some((item) => item.id === request.id) ? prev : [...prev, request]));
          return;
        }
        case "permission.replied": {
          const requestID = payload["requestID"] as string | undefined;
          setPermissions((prev) => prev.filter((item) => item.id !== requestID));
          return;
        }
        default:
          return;
      }
    };
    return () => source.close();
  }, []);

  useEffect(() => {
    if (active === undefined) return;
    let alive = true;
    fetch(`/opencode/session/${active}/message`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as Message[];
      })
      .then((list) => {
        if (!alive) return;
        setMessages((prev) => ({ ...prev, [active]: list }));
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : "加载消息失败");
      });
    return () => {
      alive = false;
    };
  }, [active]);

  const current = active === undefined ? [] : messages[active] ?? [];
  const currentBusy = active !== undefined && busy[active] === true;
  const currentPermissions = permissions.filter((item) => item.sessionID === active);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [active, current.length, currentBusy]);

  async function createSession(): Promise<void> {
    setError(undefined);
    try {
      const response = await fetch("/opencode/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "dsh" }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const info = (await response.json()) as SessionInfo;
      setSessions((prev) => [info, ...prev]);
      setActive(info.id);
      setMessages((prev) => ({ ...prev, [info.id]: [] }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建会话失败");
    }
  }

  async function send(): Promise<void> {
    const text = draft.trim();
    if (text === "" || active === undefined || currentBusy) return;
    setDraft("");
    setError(undefined);
    try {
      const response = await fetch(`/opencode/session/${active}/prompt_async`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text }] }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (reason) {
      setDraft(text);
      setError(reason instanceof Error ? reason.message : "发送失败");
    }
  }

  async function abort(): Promise<void> {
    if (active === undefined) return;
    try {
      await fetch(`/opencode/session/${active}/abort`, { method: "POST" });
    } catch {
      // 中止失败由下一次状态事件纠正。
    }
  }

  async function replyPermission(permission: Permission, reply: "once" | "always" | "reject"): Promise<void> {
    setPermissions((prev) => prev.filter((item) => item.id !== permission.id));
    try {
      await fetch(`/opencode/permission/${permission.id}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reply }),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "权限应答失败");
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  return createPortal(
    <div style={overlay} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div style={panel} onMouseDown={(event) => event.stopPropagation()}>
        <div style={header}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>OpenCode</div>
          <div style={{ color: "var(--dsw-alias-label-tertiary)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {sessions.find((item) => item.id === active)?.title ?? ""}
          </div>
          <button type="button" style={headerButton} onClick={() => void createSession()}>新建会话</button>
          <button type="button" style={headerButton} onClick={onClose}>关闭</button>
        </div>
        {error !== undefined && (
          <div style={errorBar} onClick={() => setError(undefined)}>{error}（点击关闭）</div>
        )}
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <div style={sessionList}>
            {loading && <div style={emptyHint}>加载中…</div>}
            {!loading && sessions.length === 0 && <div style={emptyHint}>还没有会话</div>}
            {sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => setActive(session.id)}
                style={{
                  ...sessionRow,
                  background: session.id === active ? "var(--dsw-alias-bg-layer-3)" : "transparent",
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {session.title ?? session.id}
                </span>
                <span style={sessionTime}>{timeLabel(session)}</span>
                {busy[session.id] === true && <span style={busyDot} />}
              </button>
            ))}
          </div>
          <div style={conversation}>
            <div style={scroll}>
              {active === undefined && <div style={emptyHint}>选择或新建一个会话</div>}
              {active !== undefined && current.length === 0 && !loading && (
                <div style={emptyHint}>发一条消息开始</div>
              )}
              <Conversation messages={current} busy={currentBusy} />
              <div ref={bottom} />
            </div>
            {currentPermissions.length > 0 && (
              <PermissionBar permissions={currentPermissions} onReply={(permission, reply) => void replyPermission(permission, reply)} />
            )}
            <div style={composer}>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder={active === undefined ? "先选择一个会话" : "发给 opencode，Enter 发送，Shift+Enter 换行"}
                disabled={active === undefined}
                style={textarea}
              />
              {currentBusy ? (
                <button type="button" style={stopButton} onClick={() => void abort()}>停止</button>
              ) : (
                <button type="button" style={sendButton} onClick={() => void send()} disabled={draft.trim() === "" || active === undefined}>
                  发送
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function OpencodeTrigger({ wide }: { wide: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label="OpenCode"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: wide ? "calc(100% + 8px)" : 36,
          height: wide ? 34 : 36,
          margin: wide ? "4px -4px 4px" : "8px 0 10px",
          padding: wide ? "6px 2px 6px 10px" : 0,
          boxSizing: "border-box",
          border: "none",
          borderRadius: wide ? 12 : "50%",
          background: "transparent",
          color: "var(--dsw-alias-label-primary)",
          cursor: "pointer",
          overflow: "hidden",
          justifyContent: wide ? "flex-start" : "center",
          fontFamily: "inherit",
          fontSize: 14,
          lineHeight: 22,
        }}
      >
        <svg width={wide ? 16 : 18} height={wide ? 16 : 18} viewBox="0 0 16 16" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M4.5 6.5 6.5 8l-2 1.5M8 9.5h3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {wide && <span style={{ overflow: "hidden", whiteSpace: "nowrap" }}>OpenCode</span>}
      </button>
      {open && <OpencodePanel onClose={() => setOpen(false)} />}
    </>
  );
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0, 0, 0, 0.35)",
};

const panel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "min(1080px, 94vw)",
  height: "min(760px, 86vh)",
  overflow: "hidden",
  borderRadius: 16,
  border: "1px solid var(--dsw-alias-border-l2)",
  background: "var(--dsw-alias-bg-layer-2)",
  color: "var(--dsw-alias-label-primary)",
  boxShadow: "0 18px 60px rgba(0, 0, 0, 0.28)",
};

const header: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 14px",
  borderBottom: "1px solid var(--dsw-alias-border-l2)",
  flex: "none",
};

const headerButton: CSSProperties = {
  marginLeft: "auto",
  padding: "4px 10px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 8,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
};

const errorBar: CSSProperties = {
  padding: "6px 14px",
  background: "var(--dsw-alias-state-error-secondary, rgba(220, 60, 60, 0.12))",
  color: "var(--dsw-alias-label-error)",
  fontSize: 12,
  cursor: "pointer",
  flex: "none",
};

const sessionList: CSSProperties = {
  width: 240,
  flex: "none",
  overflowY: "auto",
  borderRight: "1px solid var(--dsw-alias-border-l2)",
  padding: 6,
};

const sessionRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  padding: "7px 8px",
  border: "none",
  borderRadius: 8,
  color: "inherit",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 13,
  textAlign: "left",
};

const sessionTime: CSSProperties = {
  flex: "none",
  marginLeft: "auto",
  fontSize: 10,
  color: "var(--dsw-alias-label-tertiary)",
};

const busyDot: CSSProperties = {
  flex: "none",
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--dsw-alias-state-business-primary, #4c8bf5)",
};

const conversation: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
};

const scroll: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "14px 18px",
};

const emptyHint: CSSProperties = {
  padding: 18,
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: 13,
  textAlign: "center",
};

const userRow: CSSProperties = { display: "flex", justifyContent: "flex-end", margin: "8px 0" };

const userBubble: CSSProperties = {
  maxWidth: "78%",
  padding: "8px 12px",
  borderRadius: 12,
  background: "var(--dsw-alias-bg-layer-3)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  fontSize: 14,
  lineHeight: 1.55,
};

const assistantRow: CSSProperties = { margin: "8px 0", fontSize: 14, lineHeight: 1.6 };

const textBlock: CSSProperties = { whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "4px 0" };

const reasoningBlock: CSSProperties = {
  margin: "4px 0",
  padding: "4px 8px",
  borderRadius: 8,
  background: "var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.08))",
  fontSize: 12,
  color: "var(--dsw-alias-label-secondary)",
};

const reasoningSummary: CSSProperties = { cursor: "pointer", userSelect: "none" };

const reasoningText: CSSProperties = {
  ...MONO,
  margin: "6px 0 0",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  fontSize: 11,
  lineHeight: 1.5,
};

const toolCard: CSSProperties = {
  margin: "6px 0",
  padding: "6px 9px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 8,
  background: "var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.06))",
  fontSize: 12,
};

const toolHead: CSSProperties = {
  display: "flex",
  alignItems: "center",
  width: "100%",
  padding: 0,
  border: "none",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
};

const toolSummaryStyle: CSSProperties = {
  ...MONO,
  marginTop: 3,
  fontSize: 11,
  color: "var(--dsw-alias-label-tertiary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const toolDetail: CSSProperties = {
  ...MONO,
  margin: "6px 0 0",
  maxHeight: 180,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  fontSize: 11,
  lineHeight: 1.45,
};

const running: CSSProperties = {
  margin: "8px 0",
  fontSize: 12,
  color: "var(--dsw-alias-label-tertiary)",
};

const permissionBar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  margin: "0 14px 8px",
  padding: "8px 10px",
  borderRadius: 10,
  border: "1px solid var(--dsw-alias-state-warning-primary, #d19b00)",
  background: "color-mix(in srgb, var(--dsw-alias-state-warning-primary, #d19b00) 12%, transparent)",
  fontSize: 13,
};

const permitButton: CSSProperties = {
  padding: "4px 8px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 7,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
};

const rejectButton: CSSProperties = {
  ...permitButton,
  color: "var(--dsw-alias-label-error)",
};

const composer: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 8,
  padding: "10px 14px 12px",
  borderTop: "1px solid var(--dsw-alias-border-l2)",
  flex: "none",
};

const textarea: CSSProperties = {
  flex: 1,
  minHeight: 38,
  maxHeight: 160,
  resize: "vertical",
  padding: "8px 10px",
  borderRadius: 10,
  border: "1px solid var(--dsw-alias-border-l2)",
  background: "var(--dsw-alias-bg-layer-1, transparent)",
  color: "inherit",
  fontFamily: "inherit",
  fontSize: 13,
  lineHeight: 1.5,
  outline: "none",
};

const sendButton: CSSProperties = {
  flex: "none",
  height: 36,
  padding: "0 14px",
  border: "none",
  borderRadius: 9,
  background: "var(--dsw-alias-state-business-primary, #4c8bf5)",
  color: "#fff",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 13,
};

const stopButton: CSSProperties = {
  ...sendButton,
  background: "var(--dsw-alias-state-error-primary, #d64545)",
};
