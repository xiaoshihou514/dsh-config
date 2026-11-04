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
import type { OfficeInteraction, OfficeMember, OfficeSnapshot, RoleKind, Tier, Vendor } from "../office/types.ts";
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
  portrait(vendor: Vendor, tier: Tier, role: RoleKind, size?: number): string;
  propIcon(role: RoleKind, size?: number): string;
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

let scenePromise: Promise<SceneModule> | undefined;

/**
 * 场景脚本（约 600KB）：整个页面只加载一次；宿主带 ETag 协商缓存，
 * 重建 lib/office-scene.js 后刷新页面即可拿到新版本。
 */
function loadScene(): Promise<SceneModule> {
  const url: string = "/dsh-config/office/scene.js";
  scenePromise ??= import(/* @vite-ignore */ url).catch((reason: unknown) => {
    scenePromise = undefined;
    throw reason;
  }) as Promise<SceneModule>;
  return scenePromise;
}

/** 按钮出现后在浏览器空闲时预取场景脚本，点开办公室时就不用再等下载与解析。 */
function prefetchScene(): () => void {
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback;
  const run = () => void loadScene().catch(() => {});
  if (idle !== undefined) {
    const handle = idle(run, { timeout: 4000 });
    return () => (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(handle);
  }
  const timer = setTimeout(run, 1500);
  return () => clearTimeout(timer);
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
  const hasTeam = team !== undefined;
  useEffect(() => (hasTeam ? prefetchScene() : undefined), [hasTeam]);
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
        createPortal(
          <OfficeModal
            initialLeadId={leadId}
            useSessions={props.useSessions}
            useSessionStatus={props.useSessionStatus}
            openMember={props.openMember}
            onClose={() => setOpen(false)}
          />,
          document.body,
        )}
    </>
  );
}

/** 侧边栏底部「办公室」入口：不依赖当前会话，打开全屏办公室（默认最近活跃的团队）。 */
export function OfficeSidebarTrigger({
  wide,
  openMember,
}: {
  wide: boolean;
  openMember: (leadId: string, memberId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  useEffect(() => prefetchScene(), []);
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
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: wide ? "calc(100% + 8px)" : 36,
          height: wide ? 34 : 36,
          margin: wide ? "4px -4px 0" : "8px 0 0",
          padding: wide ? "6px 2px 6px 10px" : 0,
          boxSizing: "border-box",
          border: "none",
          borderRadius: wide ? 12 : "50%",
          background: hover ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
          color: "var(--dsw-alias-label-primary)",
          cursor: "pointer",
          overflow: "hidden",
          justifyContent: wide ? "flex-start" : "center",
          fontFamily: "inherit",
          fontSize: 14,
        }}
      >
        <OfficeIcon size={wide ? 16 : 18} />
        {wide && <span style={{ overflow: "hidden", whiteSpace: "nowrap" }}>办公室</span>}
      </button>
      {open && createPortal(<OfficeModal openMember={openMember} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function OfficeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
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
  useSessions: Selector<unknown> | undefined,
  useSessionStatus: Selector<unknown> | undefined,
): Record<string, boolean> {
  const key = ids.join(",");
  // 侧边栏入口没有会话存储钩子：只用宿主推导的状态。钩子有无在一次挂载内不变。
  const summary = (useSessions?.((state) => ids.map((id) => (state?.byId?.[id]?.running === true ? "1" : state?.byId?.[id] ? "0" : "-")).join("")) ?? "") as string;
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

interface TeamEntry {
  readonly leadId: string;
  readonly title?: string;
  readonly cwd?: string;
  readonly members: number;
  readonly lastActiveAt?: number;
}

/** 快速组建团队时发给新会话的项目经理提示词。 */
export const TEAM_PROMPT =
  "你是项目经理，你将接受我的指令并负责向我汇报，但你自己不能写代码。我将会向你提出需求，你需要分析并确认可能缺失的细节、分派任务给长期组员（适宜地分配职责，避免大量上下文加载切换，但同时也要避免职责过于耦合导致自改自审，你可以在后期继续调整职责分配，创建新组员）、并在一个阶段的任务完成后向我报告。总之，我们要像一个真正的技术部门一样，快速迭代、保证质量、高效沟通。现在，我授权你组建团队负责这个文件夹里的项目。";

/** 宿主侧能力（工作区 / 会话服务就绪后由 index.ts 注入）。 */
export interface OfficeHost {
  openMember(leadId: string, memberId: string): void;
  /** 已注册的工作区（文件夹）。 */
  listWorkspaces(): { workspaceId: string; path: string; title: string }[];
  /** 弹出系统选择文件夹；取消返回 null。 */
  pickDirectory(): Promise<string | null>;
  /** 在文件夹里新开会话并发送项目经理提示词，返回新会话（组长）id。 */
  createTeam(path: string): Promise<string>;
}
export const officeHost: { current: OfficeHost | undefined } = { current: undefined };

function agoShort(at: number | undefined): string {
  if (at === undefined || at <= 0) return "";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`;
  return `${Math.round(seconds / 86400)} 天前`;
}

/** 项目选择面板：已有团队（每个文件夹一个）+ 快速组建新团队。 */
function ProjectPicker({
  teams,
  leadId,
  current,
  onPick,
}: {
  teams: TeamEntry[] | null;
  leadId: string | null;
  current: { cwd?: string | undefined; title?: string | undefined } | null;
  onPick: (leadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  const host = officeHost.current;
  const teamPaths = new Set((teams ?? []).map((t) => t.cwd).filter((c): c is string => c !== undefined));
  const free = open && host !== undefined ? host.listWorkspaces().filter((w) => !teamPaths.has(w.path)) : [];
  const currentTeam = (teams ?? []).find((t) => t.leadId === leadId);
  const label = currentTeam?.cwd ?? current?.cwd;
  const create = async (path: string) => {
    if (host === undefined) return;
    setBusy(path);
    setFailure(null);
    try {
      const id = await host.createTeam(path);
      onPick(id);
      setOpen(false);
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div ref={rootRef} style={{ position: "relative", minWidth: 0 }}>
      <button type="button" aria-label="切换项目" onClick={() => setOpen(!open)} style={styles.projectButton}>
        <span style={{ fontWeight: 600, ...styles.ellipsis }}>{leadId === null ? "选择项目" : projectName(label)}</span>
        {label && <span style={{ ...styles.muted, ...styles.ellipsis, maxWidth: 220 }}>{label}</span>}
        <span style={styles.muted}>▾</span>
      </button>
      {open && (
        <div style={styles.picker} role="dialog" aria-label="选择项目">
          <div style={styles.pickerTitle}>团队</div>
          {teams === null ? (
            <div style={{ ...styles.muted, padding: "6px 10px" }}>加载中…</div>
          ) : teams.length === 0 ? (
            <div style={{ ...styles.muted, padding: "6px 10px" }}>还没有组建过团队</div>
          ) : (
            teams.map((team) => (
              <button
                key={team.leadId}
                type="button"
                onClick={() => {
                  onPick(team.leadId);
                  setOpen(false);
                }}
                style={{ ...styles.pickerRow, ...(team.leadId === leadId ? styles.pickerRowActive : {}) }}
              >
                <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1, textAlign: "left" }}>
                  <b style={styles.ellipsis}>{projectName(team.cwd)}</b>
                  <span style={{ ...styles.muted, ...styles.ellipsis }}>{team.cwd}</span>
                </span>
                <span style={{ ...styles.muted, flex: "none", textAlign: "right" }}>
                  {team.members} 人
                  <br />
                  {agoShort(team.lastActiveAt)}
                </span>
              </button>
            ))
          )}
          <div style={{ ...styles.pickerTitle, marginTop: 6 }}>
            组建新团队
            <button type="button" onClick={() => setShowPrompt(!showPrompt)} style={styles.linkButton}>
              {showPrompt ? "收起提示词" : "查看提示词"}
            </button>
          </div>
          {showPrompt && <div style={styles.promptBox}>{TEAM_PROMPT}</div>}
          {host === undefined ? (
            <div style={{ ...styles.muted, padding: "6px 10px" }}>工作区服务未就绪</div>
          ) : (
            <>
              {free.map((w) => (
                <div key={w.workspaceId} style={styles.pickerRow}>
                  <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                    <b style={styles.ellipsis}>{w.title || projectName(w.path)}</b>
                    <span style={{ ...styles.muted, ...styles.ellipsis }}>{w.path}</span>
                  </span>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void create(w.path)}
                    style={styles.smallPrimary}
                  >
                    {busy === w.path ? "组建中…" : "组建团队"}
                  </button>
                </div>
              ))}
              <button
                type="button"
                disabled={busy !== null}
                onClick={async () => {
                  const path = await host.pickDirectory().catch(() => null);
                  if (path === null) return;
                  if (teamPaths.has(path)) {
                    const existing = (teams ?? []).find((t) => t.cwd === path);
                    if (existing !== undefined) {
                      onPick(existing.leadId);
                      setOpen(false);
                    }
                    return;
                  }
                  await create(path);
                }}
                style={{ ...styles.pickerRow, justifyContent: "center", color: "var(--dsw-alias-state-business-primary)" }}
              >
                {busy !== null && !free.some((w) => w.path === busy) ? "组建中…" : "＋ 选择其他文件夹…"}
              </button>
            </>
          )}
          {failure && <div style={{ color: "var(--dsw-alias-state-error-primary)", fontSize: 12, padding: "4px 10px" }}>组建失败：{failure}</div>}
        </div>
      )}
    </div>
  );
}

function projectName(cwd: string | undefined): string {
  return cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? "未知项目";
}

/** 所有组建过团队的会话（全屏办公室的项目切换用），10 秒刷新一次。 */
function useTeams(): TeamEntry[] | null {
  const [teams, setTeams] = useState<TeamEntry[] | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch("/dsh-config/office/teams", { headers: { "x-dsh-config": "agent-office" }, cache: "no-store" });
        const body = (await response.json()) as { teams?: TeamEntry[] };
        if (!stopped && body.teams) setTeams(body.teams);
      } catch {
        if (!stopped) setTeams((prev) => prev ?? []);
      }
      if (!stopped) timer = setTimeout(load, 10_000);
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  return teams;
}

export function OfficeModal({
  initialLeadId,
  useSessions,
  useSessionStatus,
  openMember,
  onClose,
}: {
  initialLeadId?: string | undefined;
  useSessions?: Selector<unknown> | undefined;
  useSessionStatus?: Selector<unknown> | undefined;
  openMember: (leadId: string, memberId: string) => void;
  onClose: () => void;
}) {
  const teams = useTeams();
  const [leadId, setLeadId] = useState<string | null>(initialLeadId ?? null);
  // 侧边栏入口：默认打开最近活跃的团队
  useEffect(() => {
    if (leadId === null && teams !== null && teams.length > 0) setLeadId(teams[0]!.leadId);
  }, [leadId, teams]);
  const rootRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement !== null) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen?.();
  };
  const [snapshot, setSnapshot] = useState<OfficeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"office" | "gallery">("office");
  const sceneHost = useRef<HTMLDivElement>(null);
  const scene = useRef<ReturnType<SceneModule["createOfficeScene"]> | null>(null);
  const [api, setApi] = useState<SceneModule | null>(null);
  const pollNow = useRef<() => void>(() => {});
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

  // 切换项目：清空旧团队的状态
  useEffect(() => {
    setSnapshot(null);
    setSelected(null);
    setError(null);
  }, [leadId]);

  // 轮询快照
  useEffect(() => {
    if (leadId === null) return;
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
    pollNow.current = () => {
      clearTimeout(timer);
      void poll();
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [leadId]);

  // 加载场景（切换项目时重建）
  useEffect(() => {
    if (leadId === null) return;
    let disposed = false;
    loadScene()
      .then((module) => {
        if (disposed || sceneHost.current === null) return;
        scene.current = module.createOfficeScene(sceneHost.current, {
          onSelect: (id) => setSelected(id),
        });
        setApi(module);
      })
      .catch((reason) => setSceneError(String(reason)));
    return () => {
      disposed = true;
      scene.current?.dispose();
      scene.current = null;
    };
  }, [leadId]);

  useEffect(() => {
    if (snapshot !== null) scene.current?.update(snapshot, live);
  });
  useEffect(() => {
    scene.current?.select(selected);
  }, [selected]);
  useEffect(() => {
    scene.current?.setMode(mode);
  }, [mode, api, leadId]);

  const members = snapshot?.members ?? [];
  const isRunning = (m: OfficeMember) => live[m.id] ?? m.busy;
  const running = members.filter(isRunning).length;
  const member = members.find((m) => m.id === selected);

  return (
    <div ref={rootRef} style={styles.backdrop} role="dialog" aria-label="智能体办公室">
      <div style={styles.shell}>
        <header style={styles.header}>
          <strong style={{ fontSize: 15, whiteSpace: "nowrap" }}>智能体办公室</strong>
          <ProjectPicker teams={teams} leadId={leadId} current={snapshot} onPick={setLeadId} />
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
          <button
            type="button"
            aria-label={fullscreen ? "退出全屏" : "全屏"}
            title={fullscreen ? "退出全屏" : "浏览器全屏"}
            onClick={toggleFullscreen}
            style={styles.close}
          >
            {fullscreen ? "⤡" : "⤢"}
          </button>
          <button type="button" aria-label="关闭" onClick={onClose} style={styles.close}>
            ✕
          </button>
        </header>
        <div style={styles.body}>
          <div style={styles.stage}>
            <div ref={sceneHost} style={{ position: "absolute", inset: 0 }} />
            {(sceneError || error || snapshot === null) && (
              <div style={styles.notice}>
                {sceneError
                  ? `场景加载失败：${sceneError}`
                  : error
                    ? `读取团队失败：${error}`
                    : leadId === null && teams !== null && teams.length === 0
                      ? "还没有组建过团队的会话"
                      : "正在进入办公室…"}
              </div>
            )}
            {mode === "office" && (
              <div style={styles.hint}>拖动旋转 · 右键 / 双指平移 · 滚轮缩放 · 点击角色查看详情</div>
            )}
          </div>
          <aside style={styles.side}>
            {member !== undefined ? (
              <MemberPanel
                api={api}
                member={member}
                running={isRunning(member)}
                snapshot={snapshot!}
                onOverride={async (patch) => {
                  await fetch("/dsh-config/office/override", {
                    method: "POST",
                    headers: { "x-dsh-config": "agent-office", "content-type": "application/json" },
                    body: JSON.stringify({ member: member.id, ...patch }),
                  });
                  pollNow.current();
                }}
                onBack={() => setSelected(null)}
                onFocus={() => scene.current?.focus(member.id)}
                onOpen={() => {
                  if (leadId !== null) openMember(leadId, member.id);
                  onClose();
                }}
              />
            ) : (
              <TeamPanel
                api={api}
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

/** 头像：3D 角色头部特写 + 岗位色边框 + 右下角岗位道具角标；场景未加载时退回首字。 */
function Avatar({ api, member, size }: { api: SceneModule | null; member: OfficeMember; size: number }) {
  const color = ROLE_COLOR[member.roleKind];
  const [src, setSrc] = useState<{ face: string; prop: string } | null>(null);
  useEffect(() => {
    if (api === null) return;
    // 渲染头像要几十毫秒：让出一帧再画，免得卡住面板打开。
    const handle = requestAnimationFrame(() => {
      try {
        setSrc({
          face: api.portrait(member.vendor, member.tier, member.roleKind, size * 2),
          prop: api.propIcon(member.roleKind, Math.round(size * 0.9)),
        });
      } catch {
        setSrc(null);
      }
    });
    return () => cancelAnimationFrame(handle);
  }, [api, member.vendor, member.tier, member.roleKind, size]);
  const badge = Math.round(size * 0.42);
  return (
    <span style={{ position: "relative", width: size, height: size, flex: "none", display: "inline-block" }}>
      <span
        style={{
          ...styles.avatar,
          width: size,
          height: size,
          fontSize: size * 0.42,
          boxSizing: "border-box",
          border: `${size >= 40 ? 3 : 2}px solid ${color}`,
          background: src ? `color-mix(in srgb, ${color} 18%, var(--dsw-alias-bg-layer-1))` : color,
          overflow: "hidden",
        }}
      >
        {src ? (
          <img src={src.face} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", imageRendering: "pixelated" }} />
        ) : (
          ROLE_LABEL[member.roleKind][0]
        )}
      </span>
      {src && (
        <span
          style={{
            position: "absolute",
            right: -badge * 0.18,
            bottom: -badge * 0.18,
            width: badge,
            height: badge,
            borderRadius: "50%",
            background: "var(--dsw-alias-bg-layer-2)",
            border: `2px solid ${color}`,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
          title={ROLE_LABEL[member.roleKind]}
        >
          <img src={src.prop} alt="" style={{ width: "86%", height: "86%", imageRendering: "pixelated" }} />
        </span>
      )}
    </span>
  );
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
  api,
  snapshot,
  isRunning,
  onPick,
}: {
  api: SceneModule | null;
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
              <Avatar api={api} member={m} size={34} />
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

const VENDORS: Vendor[] = ["claude", "gpt", "gemini", "grok", "kimi", "qwen", "glm", "deepseek", "other"];
const ROLES: RoleKind[] = ["frontend", "backend", "qa", "reviewer", "docs", "design", "devops", "data", "general"];

type OverridePatch = { role?: RoleKind | null; vendor?: Vendor | null; tier?: Tier | null };

/** 自动识别不准时手动指定；第一项「自动」显示识别结果并恢复自动。 */
function OverrideSelect<T extends string>({
  label,
  value,
  detected,
  overridden,
  options,
  names,
  onChange,
}: {
  label: string;
  value: T;
  detected: T;
  overridden: boolean;
  options: readonly T[];
  names: Record<T, string>;
  onChange: (value: T | null) => void;
}) {
  return (
    <label style={styles.overrideRow}>
      <span style={styles.muted}>{label}</span>
      <select
        value={overridden ? value : ""}
        onChange={(event) => onChange(event.target.value === "" ? null : (event.target.value as T))}
        style={styles.select}
      >
        <option value="">自动（{names[detected]}）</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {names[option]}
          </option>
        ))}
      </select>
    </label>
  );
}

function MemberPanel({
  api,
  member,
  running,
  snapshot,
  onBack,
  onFocus,
  onOpen,
  onOverride,
}: {
  api: SceneModule | null;
  member: OfficeMember;
  running: boolean;
  snapshot: OfficeSnapshot;
  onBack: () => void;
  onFocus: () => void;
  onOpen: () => void;
  onOverride: (patch: OverridePatch) => Promise<void>;
}) {
  const [text, color] = statusText(member, running);
  const names = new Map(snapshot.members.map((m) => [m.id, m]));
  const related = snapshot.interactions.filter((i) => i.from === member.id || i.to === member.id);
  const detected = member.detected ?? { vendor: member.vendor, tier: member.tier, roleKind: member.roleKind };
  const overridden = member.overridden ?? { role: false, vendor: false, tier: false };
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
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10 }}>
        <Avatar api={api} member={member} size={64} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <b style={{ fontSize: 16 }}>{member.name}</b>
            <RoleChip member={member} />
          </div>
          <div style={{ color, fontSize: 12 }}>● {text}</div>
          <div style={styles.muted}>
            {member.provider ?? "?"} / {member.model ?? "?"}
          </div>
        </div>
      </div>
      {member.description && <p style={{ ...styles.muted, margin: "8px 0 0" }}>{member.description}</p>}
      <div style={styles.overrideBox}>
        {member.role !== "lead" && (
          <OverrideSelect
            label="岗位"
            value={member.roleKind}
            detected={detected.roleKind}
            overridden={overridden.role}
            options={ROLES}
            names={ROLE_LABEL}
            onChange={(role) => void onOverride({ role })}
          />
        )}
        <OverrideSelect
          label="人设"
          value={member.vendor}
          detected={detected.vendor}
          overridden={overridden.vendor}
          options={VENDORS}
          names={VENDOR_LABEL}
          onChange={(vendor) => void onOverride({ vendor })}
        />
        <OverrideSelect
          label="档位"
          value={member.tier}
          detected={detected.tier}
          overridden={overridden.tier}
          options={["flagship", "fast"] as Tier[]}
          names={TIER_LABEL}
          onChange={(tier) => void onOverride({ tier })}
        />
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
    display: "flex",
    background: "var(--dsw-alias-bg-layer-2)",
  },
  shell: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
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
  projectButton: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    minWidth: 0,
    maxWidth: 460,
    height: 30,
    borderRadius: 8,
    border: "0.5px solid var(--dsw-alias-border-l2)",
    background: "var(--dsw-alias-bg-layer-1)",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: 13,
    padding: "0 10px",
    cursor: "pointer",
  },
  picker: {
    position: "absolute",
    top: 36,
    left: 0,
    zIndex: 10,
    width: 420,
    maxHeight: "min(560px, 80vh)",
    overflowY: "auto",
    padding: 6,
    borderRadius: 12,
    background: "var(--dsw-alias-bg-layer-2)",
    boxShadow: "var(--dsw-elevation-prominent)",
    border: "0.5px solid var(--dsw-alias-border-l2)",
  },
  pickerTitle: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 10px 4px",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--dsw-alias-label-secondary)",
  },
  pickerRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    boxSizing: "border-box",
    padding: "7px 10px",
    border: 0,
    borderRadius: 8,
    background: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: 13,
    cursor: "pointer",
  },
  pickerRowActive: { background: "var(--dsw-alias-bg-layer-1)", boxShadow: "inset 3px 0 0 var(--dsw-alias-state-business-primary)" },
  linkButton: {
    border: 0,
    background: "transparent",
    color: "var(--dsw-alias-state-business-primary)",
    fontFamily: "inherit",
    fontSize: 12,
    cursor: "pointer",
    padding: 0,
  },
  promptBox: {
    margin: "0 10px 6px",
    padding: "8px 10px",
    borderRadius: 8,
    background: "var(--dsw-alias-bg-layer-1)",
    fontSize: 12,
    lineHeight: "18px",
    color: "var(--dsw-alias-label-secondary)",
  },
  smallPrimary: {
    flex: "none",
    height: 26,
    padding: "0 10px",
    border: 0,
    borderRadius: 7,
    cursor: "pointer",
    background: "var(--dsw-alias-state-business-primary)",
    color: "#fff",
    fontFamily: "inherit",
    fontSize: 12,
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
  overrideBox: {
    marginTop: 10,
    padding: "8px 10px",
    borderRadius: 8,
    background: "var(--dsw-alias-bg-layer-1)",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  overrideRow: { display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" },
  select: {
    flex: 1,
    maxWidth: 180,
    height: 26,
    borderRadius: 6,
    border: "0.5px solid var(--dsw-alias-border-l2)",
    background: "var(--dsw-alias-bg-layer-2)",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: 12,
    padding: "0 6px",
  },
};
