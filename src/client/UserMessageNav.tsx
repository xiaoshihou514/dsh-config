import { useMemo, useState } from "react";
import type { UseConversationSession } from "@deepseek-ai/dsh-client-runtime/client";

/** 从 ContentBlock[] 提取纯文本（导航标签用）。 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    const candidate = block as { type?: string; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string")
      out += candidate.text;
  }
  return out;
}

interface UserItem {
  key: string;
  label: string;
}

/** 收集当前会话的用户消息（含可定位的 DOM anchor key）。 */
function collectUserItems(session: {
  chat?: { order?: readonly string[]; nodes?: { get(k: string): unknown; values(): readonly unknown[] } };
  nodes?: readonly unknown[];
}): UserItem[] {
  const chatOrder = session?.chat?.order ?? [];
  const chatNodes = session?.chat?.nodes;
  const legacy = session?.nodes ?? [];
  const items: UserItem[] = [];

  // 方法一：chat 渲染节点（kind 为 input-message 且 data.kind 为 user）——key 即 DOM anchor。
  for (const key of chatOrder) {
    const node = chatNodes?.get(key) as
      | { kind?: string; data?: { kind?: string; content?: unknown } }
      | undefined;
    if (node?.kind !== "input-message") continue;
    if (node.data?.kind !== "user") continue;
    const text = textOf(node.data?.content).trim();
    if (text.length === 0) continue;
    items.push({ key, label: text.length > 56 ? `${text.slice(0, 56)}…` : text });
  }

  // 方法二（方法一未命中时）：legacy UserMessageNode，用 anchorSeq 匹配 chat 节点得到 key。
  if (items.length === 0) {
    for (const raw of legacy) {
      const node = raw as { kind?: string; seq?: number; content?: unknown };
      if (node?.kind !== "user") continue;
      const text = textOf(node?.content).trim();
      if (text.length === 0) continue;
      const matched = (chatNodes?.values() ?? []).find(
        (item) =>
          typeof (item as { anchorSeq?: unknown }).anchorSeq === "number" &&
          (item as { anchorSeq: number }).anchorSeq === node.seq,
      );
      const key = matched ? (matched as { key: string }).key : String(node.seq);
      items.push({ key, label: text.length > 56 ? `${text.slice(0, 56)}…` : text });
    }
  }

  // 诊断：确认 chat 快照是否真的有数据、判定逻辑命中情况。
  // eslint-disable-next-line no-console
  console.log(
    "[UserMessageNav] chatOrder=",
    chatOrder.length,
    "legacy=",
    legacy.length,
    "items=",
    items.length,
  );
  return items;
}

/**
 * 会话用户消息导航：默认右侧一条细线条，鼠标移入展开完整导航面板（半透明悬浮），
 * 列出当前会话所有用户消息，点击滚动到会话中对应消息。
 */
export function UserMessageNav({
  useSession,
}: {
  useSession?: UseConversationSession;
}) {
  const [open, setOpen] = useState(true);
  const session = useSession?.((snapshot) => snapshot);

  const userItems = useMemo<UserItem[]>(
    () => collectUserItems(session as never),
    [session],
  );

  const jump = (key: string): void => {
    const el = document.querySelector<HTMLElement>(
      `[data-chat-anchor-key="${CSS.escape(key)}"]`,
    );
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <div
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      style={{
        position: "fixed",
        left: 0,
        top: "45%",
        transform: "translateY(-50%)",
        zIndex: 50,
      }}
    >
      {/* 收起的细线条 */}
      <div
        style={{
          width: open ? 0 : 5,
          height: open ? 0 : 180,
          borderRadius: 0,
          background: "linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.28), rgba(255,255,255,0.05))",
          cursor: "pointer",
          transition: "width 0.2s",
        }}
        title="用户消息导航"
      />
      {/* 展开的完整面板 */}
      {open ? (
        <div
          style={{
            width: 232,
            maxHeight: "72vh",
            display: "flex",
            flexDirection: "column",
            borderRadius: 12,
            padding: 6,
            marginLeft: 8,
            background: "rgba(22, 22, 26, 0.82)",
            backdropFilter: "blur(10px)",
            border: "1px solid rgba(255,255,255,0.12)",
            boxShadow: "0 8px 28px rgba(0,0,0,0.35)",
            color: "var(--dsw-alias-label-primary)",
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              padding: "4px 8px 6px",
              opacity: 0.85,
            }}
          >
            消息导航 · {userItems.length}
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              overflowY: "auto",
              maxHeight: "calc(72vh - 34px)",
            }}
          >
            {userItems.length === 0 ? (
              <div style={{ padding: "8px 10px", fontSize: 11, opacity: 0.6 }}>
                暂无用户消息
              </div>
            ) : (
              userItems.map((item, index) => (
                <button
                  key={item.key}
                  type="button"
                  title={`跳转到第 ${index + 1} 条用户消息`}
                  onClick={() => jump(item.key)}
                  style={{
                    appearance: "none",
                    border: 0,
                    background: "transparent",
                    color: "inherit",
                    font: "inherit",
                    textAlign: "left",
                    fontSize: 12,
                    lineHeight: 1.45,
                    padding: "5px 8px",
                    borderRadius: 6,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  onMouseEnter={(event) => {
                    event.currentTarget.style.background = "rgba(255,255,255,0.08)";
                  }}
                  onMouseLeave={(event) => {
                    event.currentTarget.style.background = "transparent";
                  }}
                >
                  <span style={{ opacity: 0.45, marginRight: 6 }}>{index + 1}</span>
                  <span>{item.label}</span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
