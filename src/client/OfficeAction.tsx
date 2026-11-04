/**
 * 智能体办公室：会话头部「办公室」按钮 + 全屏弹窗。
 *
 * 弹窗轮询 `/dsh-config/office?lead=` 取团队快照，按需加载 3D 场景脚本
 * （`/dsh-config/office/scene.js`），右侧面板展示成员详情与交流动态。
 * 成员是否在跑以浏览器会话状态为准（比宿主推导更实时）。
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ROLE_COLOR, ROLE_LABEL, TIER_LABEL, VENDOR_LABEL } from "../office/classify.ts";
import type { OfficeActivity, OfficeInteraction, OfficeMember, OfficeSnapshot } from "../office/types.ts";
import { USER_ID } from "../office/types.ts";

type Selector<T> = (selector: (state: any) => T) => T;

export interface OfficeActionProps {
  sessionId: string;
  useSession: Selector<unknown>;
  useSessions: Selector<unknown>;
  useSessionStatus?: Selector<unknown>;
  openMember: (leadId: string, memberId: string) => void;
}

interface SceneModule {
  createOfficeScene(
    container: HTMLElement,
    options: { onSelect(id: string | null): void },
  ): {
    update(snapshot: OfficeSnapshot, live: Record<string, boolean>): void;
    select(id: string | null): void;
    focus(id: string): void;
    setMode(mode: "office" | "gallery"): void;
    dispose(): void;
  };
}

const POLL_MS = 1500;

function loadScene(): Promise<SceneModule> {
  // 每次打开都带时间戳，重建 lib/office-scene.js 后刷新即可拿到新版本。
  const url = `/dsh-config/office/scene.js?t=${Date.now()}`;
  return import(/* @vite-ignore */ url) as Promise<SceneModule>;
}

// ---------------------------------------------------------------- 按钮

export function OfficeAction(props: OfficeActionProps) {
  const { sessionId, useSession, useSessions } = props;
  const leadId =
    (useSession((snapshot) => snapshot?.subagent?.address?.parentSessionId) as string | undefined) ?? sessionId;
  const team = useSessions((state) => state?.projectionsBySession?.[leadId]?.values?.agentTeam) as
    | { members: unknown[] }
    | undefined;
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  if (team === undefined) return null;
  return (
    <>
      <button
        type="button"
        aria-label="智能体办公室"
        title="智能体办公室"
        onClick={() => setOpen(true)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          minHeight: 28,
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          padding: "3px 7px",
          border: 0,
          borderRadius: 6,
          background: "transparent",
          color: hover ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-tertiary)",
          cursor: "pointer",
          fontSize: 12,
          fontFamily: "inherit",
        }}
      >
        <OfficeIcon />
        <span>办公室</span>
      </button>
      {open &&
        createPortal(<OfficeModal {...props} leadId={leadId} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function OfficeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M2 14V6.5L8 3l6 3.5V14" strokeLinejoin="round" />
      <path d="M5.5 14v-3.5h5V14M1 14h14" strokeLinecap="round" />
      <rect x="4.5" y="6.8" width="2" height="1.6" rx=".3" />
      <rect x="9.5" y="6.8" width="2" height="1.6" rx=".3" />
    </svg>
  );
}

// ---------------------------------------------------------------- 弹窗

function useLive(
  ids: readonly string[],
  useSessions: Selector<unknown>,
  useSessionStatus: Selector<unknown> | undefined,
): Record<string, boolean> {
  const key = ids.join(",");
  const summary = useSessions((state) => ids.map((id) => (state?.byId?.[id]?.running === true ? "1" : state?.byId?.[id] ? "0" : "-")).join("")) as string;
  const status = (useSessionStatus?.((state) =>
    ids.map((id) => {
      const running = state?.get?.(id)?.running;
      return running === true ? "1" : running === false ? "0" : "-";
    }).join(""),
  ) ?? "") as string;
  return useMemo(() => {
    const live: Record<string, boolean> = {};
    ids.forEach((id, index) => {
      const value = status[index] !== undefined && status[index] !== "-" ? status[index] : summary[index];
      if (value === "1") live[id] = true;
      else if (value === "0") live[id] = false;
    });
    return live;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, summary, status]);
}

function OfficeModal({
  leadId,
  useSessions,
  useSessionStatus,
  openMember,
  onClose,
}: OfficeActionProps & { leadId: string; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<OfficeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"office" | "gallery">("office");
  const sceneHost = useRef<HTMLDivElement>(null);
  const scene = useRef<ReturnType<SceneModule["createOfficeScene"]> | null>(null);
  const memberIds = useMemo(() => snapshot?.members.map((m) => m.id) ?? [], [snapshot]);
  const live = useLive(memberIds, useSessions, useSessionStatus);

  // Esc 关闭
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 轮询快照
  useEffect(() => {
    let stopped = false;
    let etag = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/dsh-config/office?lead=${encodeURIComponent(leadId)}`, {
          headers: { "x-dsh-config": "agent-office", ...(etag ? { "if-none-match": etag } : {}) },
          cache: "no-store",
        });
        if (response.status === 200) {
          etag = response.headers.get("etag") ?? "";
          const body = (await response.json()) as { ok: boolean; snapshot?: OfficeSnapshot; error?: string };
          if (!stopped && body.snapshot) {
            setSnapshot(body.snapshot);
            setError(null);
          }
        } else if (response.status !== 304) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          if (!stopped) setError(body.error ?? `HTTP ${response.status}`);
        }
      } catch (reason) {
        if (!stopped) setError(String(reason));
      }
      if (!stopped) timer = setTimeout(poll, document.hidden ? POLL_MS * 4 : POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [leadId]);

  // 加载场景
  useEffect(() => {
    let disposed = false;
    loadScene()
      .then((module) => {
        if (disposed || sceneHost.current === null) return;
        scene.current = module.createOfficeScene(sceneHost.current, {
          onSelect: (id) => setSelected(id),
        });
      })
      .catch((reason) => setSceneError(String(reason)));
    return () => {
      disposed = true;
      scene.current?.dispose();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    if (snapshot !== null) scene.current?.update(snapshot, live);
  });
  useEffect(() => {
    scene.current?.select(selected);
  }, [selected]);
  useEffect(() => {
    scene.current?.setMode(mode);
  }, [mode]);

  const members = snapshot?.members ?? [];
  const isRunning = (m: OfficeMember) => live[m.id] ?? m.busy;
  const running = members.filter(isRunning).length;
  const member = members.find((m) => m.id === selected);

  return (
    <div style={styles.backdrop} role="dialog" aria-label="智能体办公室">
      <div style={styles.shell}>
        <header style={styles.header}>
          <strong style={{ fontSize: 15 }}>智能体办公室</strong>
          {snapshot?.title && <span style={styles.muted}>· {snapshot.title}</span>}
          <span style={styles.chip}>成员 {members.length}</span>
          <span style={{ ...styles.chip, color: running > 0 ? "var(--dsw-alias-state-success-primary)" : undefined }}>
            工作中 {running}
          </span>
          <span style={styles.chip}>交流 {snapshot?.interactions.length ?? 0}</span>
          <div style={{ flex: 1 }} />
          <div style={styles.segment}>
            {(["office", "gallery"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                style={{ ...styles.segmentButton, ...(mode === value ? styles.segmentActive : {}) }}
              >
                {value === "office" ? "办公室" : "角色图鉴"}
              </button>
            ))}
          </div>
          <button type="button" aria-label="关闭" onClick={onClose} style={styles.close}>
            ✕
          </button>
        </header>
        <div style={styles.body}>
          <div style={styles.stage}>
            <div ref={sceneHost} style={{ position: "absolute", inset: 0 }} />
            {(sceneError || error || snapshot === null) && (
              <div style={styles.notice}>
                {sceneError ? `场景加载失败：${sceneError}` : error ? `读取团队失败：${error}` : "正在进入办公室…"}
              </div>
            )}
            {mode === "office" && (
              <div style={styles.hint}>拖动旋转 · 右键 / 双指平移 · 滚轮缩放 · 点击角色查看详情</div>
            )}
          </div>
          <aside style={styles.side}>
            {member !== undefined ? (
              <MemberPanel
                member={member}
                running={isRunning(member)}
                snapshot={snapshot!}
                onBack={() => setSelected(null)}
                onFocus={() => scene.current?.focus(member.id)}
                onOpen={() => {
                  openMember(leadId, member.id);
                  onClose();
                }}
              />
            ) : (
              <TeamPanel
                snapshot={snapshot}
                isRunning={isRunning}
                onPick={(id) => {
                  setSelected(id);
                  setMode("office");
                  scene.current?.focus(id);
                }}
              />
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 面板

function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`;
  return new Date(at).toLocaleDateString();
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function RoleChip({ member }: { member: OfficeMember }) {
  return (
    <span style={{ ...styles.roleChip, background: ROLE_COLOR[member.roleKind] }}>{ROLE_LABEL[member.roleKind]}</span>
  );
}

function statusText(member: OfficeMember, running: boolean): [string, string] {
  if (member.phase === "failed") return ["创建失败", "var(--dsw-alias-state-error-primary)"];
  if (member.phase === "provisioning") return ["入职中", "var(--dsw-alias-state-business-primary)"];
  if (running) return ["工作中", "var(--dsw-alias-state-success-primary)"];
  return ["空闲", "var(--dsw-alias-label-tertiary)"];
}

const KIND_LABEL: Record<OfficeInteraction["kind"], string> = {
  spawn: "招募",
  message: "消息",
  report: "完工汇报",
  instruction: "你的指令",
};

function InteractionItem({ item, names }: { item: OfficeInteraction; names: Map<string, OfficeMember> }) {
  const [open, setOpen] = useState(false);
  const from = item.from === USER_ID ? "你" : (names.get(item.from)?.name ?? "?");
  const to = names.get(item.to)?.name ?? "?";
  const color =
    item.kind === "instruction" ? "#e3b546" : item.kind === "report" ? "#4fb85b" : item.kind === "spawn" ? "#9a6cf0" : "#5b7fd6";
  return (
    <li style={styles.feedItem} onClick={() => setOpen(!open)}>
      <div style={styles.feedHead}>
        <span style={{ ...styles.kindDot, background: color }} />
        <b>{from}</b>
        <span style={styles.muted}>→</span>
        <b>{to}</b>
        <span style={{ ...styles.muted, marginLeft: 4 }}>{KIND_LABEL[item.kind]}</span>
        <span style={{ ...styles.muted, marginLeft: "auto" }}>{clock(item.at)}</span>
      </div>
      {open ? <pre style={styles.fullText}>{item.text}</pre> : <div style={styles.preview}>{item.preview}</div>}
    </li>
  );
}

function TeamPanel({
  snapshot,
  isRunning,
  onPick,
}: {
  snapshot: OfficeSnapshot | null;
  isRunning: (m: OfficeMember) => boolean;
  onPick: (id: string) => void;
}) {
  if (snapshot === null) return <div style={styles.muted}>加载中…</div>;
  const names = new Map(snapshot.members.map((m) => [m.id, m]));
  return (
    <>
      <h3 style={styles.h3}>成员</h3>
      <div style={styles.roster}>
        {snapshot.members.map((m) => {
          const [text, color] = statusText(m, isRunning(m));
          return (
            <button key={m.id} type="button" style={styles.memberCard} onClick={() => onPick(m.id)}>
              <span style={{ ...styles.avatar, background: ROLE_COLOR[m.roleKind] }}>{ROLE_LABEL[m.roleKind][0]}</span>
              <span style={{ minWidth: 0, flex: 1, textAlign: "left" }}>
                <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <b style={styles.ellipsis}>{m.name}</b>
                  <span style={{ color, fontSize: 11 }}>● {text}</span>
                </span>
                <span style={{ ...styles.muted, ...styles.ellipsis, display: "block" }}>
                  {VENDOR_LABEL[m.vendor]} · {TIER_LABEL[m.tier]} · {m.model ?? "未知模型"}
                </span>
                {isRunning(m) && m.current && (
                  <span style={{ ...styles.ellipsis, display: "block", fontSize: 11 }}>{m.current.label}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      <h3 style={styles.h3}>交流动态</h3>
      {snapshot.interactions.length === 0 ? (
        <div style={styles.muted}>还没有交流记录</div>
      ) : (
        <ul style={styles.feed}>
          {[...snapshot.interactions].reverse().slice(0, 60).map((item) => (
            <InteractionItem key={item.id} item={item} names={names} />
          ))}
        </ul>
      )}
    </>
  );
}

const ACTIVITY_ICON: Record<OfficeActivity["kind"], string> = {
  tool: "🔧",
  say: "💬",
  think: "💭",
  receive: "📨",
  turn: "✅",
  error: "⚠️",
};
const CATEGORY_ICON: Record<string, string> = {
  shell: "⌨️",
  read: "📖",
  edit: "✏️",
  search: "🔍",
  web: "🌐",
  team: "👥",
  plan: "📋",
  wait: "⏳",
  other: "🔧",
};

function ActivityItem({ entry }: { entry: OfficeActivity }) {
  const [open, setOpen] = useState(false);
  const icon = entry.kind === "tool" ? CATEGORY_ICON[entry.category ?? "other"] : ACTIVITY_ICON[entry.kind];
  return (
    <li style={styles.activity} onClick={() => entry.detail && setOpen(!open)}>
      <span style={{ width: 18, flex: "none" }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        {open && entry.detail ? (
          <pre style={styles.fullText}>{entry.detail}</pre>
        ) : (
          <span style={{ ...styles.ellipsis, display: "block", color: entry.failed ? "var(--dsw-alias-state-error-primary)" : undefined }}>
            {entry.label}
          </span>
        )}
      </span>
      <span style={{ ...styles.muted, flex: "none" }}>{clock(entry.at)}</span>
    </li>
  );
}

function MemberPanel({
  member,
  running,
  snapshot,
  onBack,
  onFocus,
  onOpen,
}: {
  member: OfficeMember;
  running: boolean;
  snapshot: OfficeSnapshot;
  onBack: () => void;
  onFocus: () => void;
  onOpen: () => void;
}) {
  const [text, color] = statusText(member, running);
  const names = new Map(snapshot.members.map((m) => [m.id, m]));
  const related = snapshot.interactions.filter((i) => i.from === member.id || i.to === member.id);
  const stats: [string, ReactNode][] = [
    ["轮次", member.stats.turns],
    ["步骤", member.stats.steps],
    ["工具调用", member.stats.toolCalls],
    ["发出消息", member.stats.sent],
    ["收到消息", member.stats.received],
    ["输出词元", member.stats.outputTokens.toLocaleString()],
  ];
  return (
    <>
      <button type="button" onClick={onBack} style={styles.back}>
        ← 全部成员
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
        <span style={{ ...styles.avatar, width: 40, height: 40, fontSize: 18, background: ROLE_COLOR[member.roleKind] }}>
          {ROLE_LABEL[member.roleKind][0]}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <b style={{ fontSize: 16 }}>{member.name}</b>
            <RoleChip member={member} />
          </div>
          <div style={{ color, fontSize: 12 }}>● {text}</div>
        </div>
      </div>
      {member.description && <p style={{ ...styles.muted, margin: "8px 0 0" }}>{member.description}</p>}
      <div style={styles.modelBox}>
        <div>
          <b>{VENDOR_LABEL[member.vendor]}</b> · {TIER_LABEL[member.tier]}档
        </div>
        <div style={styles.muted}>
          {member.provider ?? "?"} / {member.model ?? "?"}
        </div>
      </div>
      {running && member.current && (
        <div style={styles.current}>
          正在：{member.current.label}
          <span style={styles.muted}>（{ago(member.current.since)}开始）</span>
        </div>
      )}
      {member.error && <div style={{ ...styles.current, color: "var(--dsw-alias-state-error-primary)" }}>{member.error}</div>}
      <div style={styles.stats}>
        {stats.map(([label, value]) => (
          <div key={label} style={styles.stat}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{value}</div>
            <div style={styles.muted}>{label}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, margin: "10px 0" }}>
        <button type="button" style={styles.primary} onClick={onOpen}>
          打开会话
        </button>
        <button type="button" style={styles.secondary} onClick={onFocus}>
          镜头对准
        </button>
      </div>
      <h3 style={styles.h3}>最近活动</h3>
      {member.activity.length === 0 ? (
        <div style={styles.muted}>暂无活动</div>
      ) : (
        <ul style={styles.feed}>
          {[...member.activity].reverse().slice(0, 40).map((entry, index) => (
            <ActivityItem key={`${entry.at}:${index}`} entry={entry} />
          ))}
        </ul>
      )}
      {related.length > 0 && (
        <>
          <h3 style={styles.h3}>相关交流</h3>
          <ul style={styles.feed}>
            {[...related].reverse().slice(0, 30).map((item) => (
              <InteractionItem key={item.id} item={item} names={names} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- 样式

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 1000,
    background: "rgba(0,0,0,0.35)",
    display: "flex",
    padding: 16,
    boxSizing: "border-box",
  },
  shell: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    borderRadius: 14,
    overflow: "hidden",
    background: "var(--dsw-alias-bg-layer-2)",
    color: "var(--dsw-alias-label-primary)",
    boxShadow: "var(--dsw-elevation-prominent)",
    fontSize: 13,
  },
  header: {
    height: 50,
    flex: "none",
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 12px 0 18px",
    borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
  },
  chip: {
    padding: "2px 8px",
    borderRadius: 999,
    background: "var(--dsw-alias-bg-layer-1)",
    fontSize: 12,
    color: "var(--dsw-alias-label-secondary)",
  },
  segment: { display: "flex", padding: 2, borderRadius: 8, background: "var(--dsw-alias-bg-layer-1)" },
  segmentButton: {
    border: 0,
    background: "transparent",
    padding: "4px 12px",
    borderRadius: 6,
    cursor: "pointer",
    color: "var(--dsw-alias-label-secondary)",
    fontFamily: "inherit",
    fontSize: 12,
  },
  segmentActive: {
    background: "var(--dsw-alias-bg-layer-2)",
    color: "var(--dsw-alias-label-primary)",
    boxShadow: "0 1px 2px rgba(0,0,0,.12)",
  },
  close: {
    width: 30,
    height: 30,
    border: 0,
    borderRadius: 8,
    background: "transparent",
    cursor: "pointer",
    color: "var(--dsw-alias-label-secondary)",
    fontSize: 14,
  },
  body: { flex: 1, minHeight: 0, display: "flex" },
  stage: {
    flex: 1,
    minWidth: 0,
    position: "relative",
    background: "linear-gradient(180deg, #cfe3f5 0%, #eef3f8 60%, #f5efe6 100%)",
  },
  notice: {
    position: "absolute",
    left: "50%",
    top: 16,
    transform: "translateX(-50%)",
    padding: "6px 12px",
    borderRadius: 8,
    background: "rgba(20,24,33,.75)",
    color: "#fff",
    fontSize: 12,
  },
  hint: {
    position: "absolute",
    left: 12,
    bottom: 10,
    fontSize: 11,
    color: "rgba(30,40,55,.6)",
    pointerEvents: "none",
  },
  side: {
    width: 340,
    flex: "none",
    overflowY: "auto",
    padding: "12px 14px 20px",
    borderLeft: "0.5px solid var(--dsw-alias-border-l2)",
    boxSizing: "border-box",
  },
  h3: { fontSize: 13, fontWeight: 600, margin: "16px 0 8px" },
  muted: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 },
  ellipsis: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  roster: { display: "flex", flexDirection: "column", gap: 6 },
  memberCard: {
    display: "flex",
    gap: 10,
    alignItems: "center",
    padding: "8px 10px",
    border: 0,
    borderRadius: 9,
    background: "var(--dsw-alias-bg-layer-1)",
    cursor: "pointer",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: 13,
  },
  avatar: {
    width: 30,
    height: 30,
    flex: "none",
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#1b1b1b",
    fontWeight: 700,
    fontSize: 13,
  },
  roleChip: { padding: "0 6px", borderRadius: 999, fontSize: 11, fontWeight: 600, color: "#1b1b1b" },
  feed: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 },
  feedItem: { padding: "7px 9px", borderRadius: 8, background: "var(--dsw-alias-bg-layer-1)", cursor: "pointer" },
  feedHead: { display: "flex", alignItems: "center", gap: 5, fontSize: 12 },
  kindDot: { width: 7, height: 7, borderRadius: "50%", flex: "none" },
  preview: {
    marginTop: 3,
    fontSize: 12,
    color: "var(--dsw-alias-label-secondary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fullText: {
    margin: "4px 0 0",
    maxHeight: 260,
    overflowY: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontFamily: "inherit",
    fontSize: 12,
    lineHeight: "18px",
    color: "var(--dsw-alias-label-secondary)",
  },
  back: {
    border: 0,
    background: "transparent",
    padding: 0,
    cursor: "pointer",
    color: "var(--dsw-alias-label-tertiary)",
    fontFamily: "inherit",
    fontSize: 12,
  },
  modelBox: { marginTop: 10, padding: "8px 10px", borderRadius: 8, background: "var(--dsw-alias-bg-layer-1)" },
  current: { marginTop: 8, fontSize: 12 },
  stats: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginTop: 10 },
  stat: { padding: "6px 8px", borderRadius: 8, background: "var(--dsw-alias-bg-layer-1)" },
  primary: {
    flex: 1,
    height: 30,
    border: 0,
    borderRadius: 8,
    cursor: "pointer",
    background: "var(--dsw-alias-state-business-primary)",
    color: "#fff",
    fontFamily: "inherit",
    fontSize: 12,
  },
  secondary: {
    flex: 1,
    height: 30,
    border: "0.5px solid var(--dsw-alias-border-l2)",
    borderRadius: 8,
    cursor: "pointer",
    background: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: 12,
  },
  activity: { display: "flex", gap: 6, alignItems: "flex-start", padding: "4px 6px", borderRadius: 6, fontSize: 12, cursor: "default" },
};
