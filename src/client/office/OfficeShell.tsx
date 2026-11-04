/**
 * 智能体办公室（办公室模式）。
 *
 * 挂在 `shell.overlay`。默认铺满窗口：左栏成员 / 详情 / 交流，中间 3D 场景，顶部 HUD。
 * 点成员「打开对话」：切换当前会话，覆盖层收成左侧成员栏，3D 场景隐藏，右边是原生
 * 对话（中央列靠左内边距让出成员栏）；Esc 或「回到办公室」收起对话。开关与正在看的
 * 团队持久化，刷新后直接回到办公室。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ROLE_COLOR, ROLE_LABEL, TIER_LABEL, VENDOR_LABEL } from "../../office/classify.ts";
import type { OfficeInteraction, OfficeMember, OfficeSnapshot, RoleKind, Tier, Vendor } from "../../office/types.ts";
import { USER_ID } from "../../office/types.ts";
import { currentSession, setOffice, useOffice } from "./store.ts";
import { CSS } from "./styles.ts";

type Selector<T> = (selector: (state: any) => T) => T;

export interface SceneModule {
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
    setPaused?(paused: boolean): void;
    dispose(): void;
  };
}

/** 快速组建团队时发给新会话的项目经理提示词。 */
export const TEAM_PROMPT =
  "你是项目经理，你将接受我的指令并负责向我汇报，但你自己不能写代码。我将会向你提出需求，你需要分析并确认可能缺失的细节、分派任务给长期组员（适宜地分配职责，避免大量上下文加载切换，但同时也要避免职责过于耦合导致自改自审，你可以在后期继续调整职责分配，创建新组员）、并在一个阶段的任务完成后向我报告。总之，我们要像一个真正的技术部门一样，快速迭代、保证质量、高效沟通。现在，我授权你组建团队负责这个文件夹里的项目。";

/** 宿主侧能力（index.ts 在工作区 / 会话 / 布局服务就绪后填入）。 */
export interface OfficeHost {
  /** 在原生对话栏打开会话（成员子会话或组长）。 */
  openSession(leadId: string, sessionId: string): void;
  /** 让中央列显示对话（而不是其他全局面板）。 */
  showConversation(): void;
  listWorkspaces(): { workspaceId: string; path: string; title: string }[];
  /** 工作区列表变化（改名、新增）时通知。 */
  subscribeWorkspaces(listener: () => void): () => void;
  /** 给项目（文件夹对应的工作区）改名；文件夹还不是工作区时先注册。 */
  renameProject(path: string, title: string): Promise<void>;
  pickDirectory(): Promise<string | null>;
  createTeam(path: string): Promise<string>;
}
export const officeHost: { current: OfficeHost | undefined } = { current: undefined };

const POLL_MS = 1500;

// ---------------------------------------------------------------- 场景脚本

let scenePromise: Promise<SceneModule> | undefined;
export function loadScene(): Promise<SceneModule> {
  // 测试页可预先注入场景模块
  const injected = (globalThis as { __dshOfficeScene?: SceneModule }).__dshOfficeScene;
  if (injected !== undefined) return Promise.resolve(injected);
  const url: string = "/dsh-config/office/scene.js";
  scenePromise ??= import(/* @vite-ignore */ url).catch((reason: unknown) => {
    scenePromise = undefined;
    throw reason;
  }) as Promise<SceneModule>;
  return scenePromise;
}

export function prefetchScene(): () => void {
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

function ensureCss(): void {
  if (document.getElementById("dsh-config-office-css") !== null) return;
  const style = document.createElement("style");
  style.id = "dsh-config-office-css";
  style.textContent = CSS;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------- 侧边栏开关

export function OfficeToggle({ wide }: { wide: boolean }) {
  const { on } = useOffice();
  useEffect(() => prefetchScene(), []);
  useEffect(ensureCss, []);
  return (
    <button
      type="button"
      className={`dso-side-toggle${wide ? " wide" : ""}${on ? " on" : ""}`}
      aria-pressed={on}
      title="切换到智能体办公室"
      onClick={() => {
        setOffice({ on: true });
        officeHost.current?.showConversation();
      }}
    >
      <OfficeIcon size={wide ? 16 : 18} />
      {wide && <span>办公室</span>}
    </button>
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

// ---------------------------------------------------------------- 数据

interface TeamEntry {
  readonly leadId: string;
  readonly title?: string;
  readonly cwd?: string;
  readonly members: number;
  readonly lastActiveAt?: number;
}

/**
 * 项目显示名：文件夹对应工作区的标题（原生侧边栏里也能改），没有时用文件夹名。
 * 工作区列表变化（改名）时重新渲染。
 */
function useProjectName(): (cwd: string | undefined) => string {
  const [, setVersion] = useState(0);
  useEffect(() => officeHost.current?.subscribeWorkspaces(() => setVersion((v) => v + 1)), []);
  const titles = new Map((officeHost.current?.listWorkspaces() ?? []).map((w) => [w.path, w.title]));
  return (cwd) => {
    const title = cwd === undefined ? undefined : titles.get(cwd)?.trim();
    return title !== undefined && title.length > 0 ? title : projectName(cwd);
  };
}

/** 行内改名：Enter 保存、Esc 取消、失焦保存。 */
function RenameInput({ initial, onDone }: { initial: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (result: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(result);
  };
  return (
    <input
      ref={ref}
      className="dso-rename"
      value={value}
      maxLength={60}
      placeholder="项目名称"
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(value.trim());
        if (event.key === "Escape") {
          event.preventDefault();
          finish(null);
        }
      }}
      onBlur={() => finish(value.trim())}
    />
  );
}

function projectName(cwd: string | undefined): string {
  return cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? "未知项目";
}

function agoShort(at: number | undefined): string {
  if (at === undefined || at <= 0) return "";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`;
  return `${Math.round(seconds / 86400)} 天前`;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** 组建过团队的项目（每个文件夹一个）；接口不可用时 error 有值。 */
function useTeams(): { teams: TeamEntry[] | null; error: string | null; reload: () => void } {
  const [teams, setTeams] = useState<TeamEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reloadRef = useRef<() => void>(() => {});
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch("/dsh-config/office/teams", { headers: { "x-dsh-config": "agent-office" }, cache: "no-store" });
        if (response.status === 404) throw new Error("团队列表接口未就绪（重启 dsh web 后可用）");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { teams?: TeamEntry[] };
        if (!stopped) {
          setTeams(body.teams ?? []);
          setError(null);
        }
      } catch (reason) {
        if (!stopped) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setTeams((prev) => prev ?? []);
        }
      }
      if (!stopped) timer = setTimeout(load, 10_000);
    };
    reloadRef.current = () => {
      clearTimeout(timer);
      void load();
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  return { teams, error, reload: () => reloadRef.current() };
}

function useLive(
  ids: readonly string[],
  useSessions: Selector<unknown> | undefined,
  useSessionStatus: Selector<unknown> | undefined,
): Record<string, boolean> {
  const key = ids.join(",");
  const summary = (useSessions?.((state) =>
    ids.map((id) => (state?.byId?.[id]?.running === true ? "1" : state?.byId?.[id] ? "0" : "-")).join(""),
  ) ?? "") as string;
  const status = (useSessionStatus?.((state) =>
    ids
      .map((id) => {
        const running = state?.get?.(id)?.running;
        return running === true ? "1" : running === false ? "0" : "-";
      })
      .join(""),
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

// ---------------------------------------------------------------- 覆盖层

/** 对话展开时左侧成员栏宽度。 */
const SIDE_W = 340;

/**
 * 覆盖层几何。对话收起：铺满窗口（3D 办公室）。对话展开：只占左侧成员栏宽度，
 * 并给原生中央列加左内边距，让原生对话从成员栏右边开始、占满其余区域。
 */
function useGeometry(on: boolean, chatOpen: boolean): void {
  useLayoutEffect(() => {
    const body = document.body;
    const clear = () => {
      body.removeAttribute("data-dsh-office");
      body.style.removeProperty("--dsh-office-pad");
    };
    if (!on || !chatOpen) {
      clear();
      return;
    }
    let raf = 0;
    const apply = () => {
      const col = document.querySelector<HTMLElement>('[class*="_centerCol"]');
      const left = col?.getBoundingClientRect().left ?? 0;
      body.style.setProperty("--dsh-office-pad", `${Math.max(0, Math.round(SIDE_W - left))}px`);
    };
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(apply);
    };
    // 首次在布局阶段同步算好再挂属性，展开时只重排一次。
    apply();
    body.setAttribute("data-dsh-office", "");
    const col = document.querySelector<HTMLElement>('[class*="_centerCol"]');
    const observer = new ResizeObserver(measure);
    if (col) observer.observe(col);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("resize", measure);
      clear();
    };
  }, [on, chatOpen]);
}

export function OfficeOverlay(props: { useSessions?: Selector<unknown>; useSessionStatus?: Selector<unknown> }) {
  const { on, chatOpen } = useOffice();
  useEffect(ensureCss, []);
  useGeometry(on, chatOpen);
  // Esc：对话展开时回到 3D 办公室（别的组件已处理的 Esc 不抢）。
  useEffect(() => {
    if (!on || !chatOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      setOffice({ chatOpen: false });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [on, chatOpen]);
  if (!on) return null;
  return (
    <div className={`dso-root${chatOpen ? " chat" : ""}`} style={chatOpen ? { width: SIDE_W } : { right: 0 }}>
      <Office {...props} />
    </div>
  );
}

// ---------------------------------------------------------------- 主体

function Office({ useSessions, useSessionStatus }: { useSessions?: Selector<unknown>; useSessionStatus?: Selector<unknown> }) {
  const { lead: storedLead, chatOpen } = useOffice();
  const { teams, error: teamsError, reload: reloadTeams } = useTeams();
  const [snapshot, setSnapshot] = useState<OfficeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"office" | "gallery">("office");
  const [api, setApi] = useState<SceneModule | null>(null);
  const sceneHost = useRef<HTMLDivElement>(null);
  const scene = useRef<ReturnType<SceneModule["createOfficeScene"]> | null>(null);
  const pollNow = useRef<() => void>(() => {});
  const rootRef = useRef<HTMLDivElement>(null);

  // 选团队：记录的 → 当前会话所在团队 → 最近活跃的 → 当前会话本身（接口不可用时）
  const leadId = useMemo(() => {
    if (storedLead !== null) return storedLead;
    if (teams === null) return null;
    const { sessionId, parentSessionId } = currentSession();
    const inTeams = (id: string | undefined) => (id !== undefined && teams.some((t) => t.leadId === id) ? id : undefined);
    return inTeams(parentSessionId) ?? inTeams(sessionId) ?? teams[0]?.leadId ?? parentSessionId ?? sessionId ?? null;
  }, [storedLead, teams]);
  useEffect(() => {
    if (storedLead === null && leadId !== null) setOffice({ lead: leadId });
  }, [storedLead, leadId]);

  const memberIds = useMemo(() => snapshot?.members.map((m) => m.id) ?? [], [snapshot]);
  const live = useLive(memberIds, useSessions, useSessionStatus);

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
          const body = (await response.json()) as { snapshot?: OfficeSnapshot };
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

  // 场景（切换团队时重建）
  useEffect(() => {
    if (leadId === null) return;
    let disposed = false;
    loadScene()
      .then((module) => {
        if (disposed || sceneHost.current === null) return;
        scene.current = module.createOfficeScene(sceneHost.current, { onSelect: (id) => setSelected(id) });
        setApi(module);
      })
      .catch((reason) => setSceneError(String(reason)));
    return () => {
      disposed = true;
      scene.current?.dispose();
      scene.current = null;
    };
  }, [leadId]);

  const nameOf = useProjectName();
  const displayName = snapshot === null ? undefined : nameOf(snapshot.cwd);
  useEffect(() => {
    if (snapshot !== null) scene.current?.update({ ...snapshot, projectName: displayName }, live);
  });
  useEffect(() => scene.current?.select(selected), [selected]);
  useEffect(() => scene.current?.setMode(mode), [mode, api, leadId]);
  useEffect(() => scene.current?.setPaused?.(chatOpen), [chatOpen, api, leadId]);

  const members = snapshot?.members ?? [];
  const isRunning = (m: OfficeMember) => live[m.id] ?? m.busy;
  const running = members.filter(isRunning).length;
  const member = members.find((m) => m.id === selected);
  const openChat = (id: string) => {
    if (leadId === null) return;
    // 先立刻收起 3D、展开对话栏；打开会话（要加载历史）放到下一刻，免得点击后界面卡住不动。
    setOffice({ chatOpen: true });
    setTimeout(() => {
      officeHost.current?.showConversation();
      const current = currentSession();
      const already = current.sessionId === id || (id === leadId && current.sessionId === leadId);
      if (!already) officeHost.current?.openSession(leadId, id);
    }, 0);
  };
  const pickTeam = (id: string) => {
    setOffice({ lead: id });
    officeHost.current?.openSession(id, id);
  };

  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const notice = sceneError
    ? `场景加载失败：${sceneError}`
    : error
      ? `读取团队失败：${error}`
      : leadId === null
        ? teams === null
          ? "正在进入办公室…"
          : "还没有团队：在左上角「项目」里组建一个吧"
        : snapshot === null
          ? "正在进入办公室…"
          : null;

  return (
    <div ref={rootRef} className={`dso-office${chatOpen ? " chat" : ""}`}>
      {chatOpen && (
        <header className="dso-chathead">
          <button type="button" className="dso-btn primary dso-backoffice" onClick={() => setOffice({ chatOpen: false })}>
            <OfficeIcon size={14} />
            回到办公室
            <kbd>Esc</kbd>
          </button>
          <ProjectPicker
            teams={teams}
            teamsError={teamsError}
            leadId={leadId}
            current={snapshot}
            onPick={pickTeam}
            onCreated={(id) => {
              pickTeam(id);
              reloadTeams();
            }}
          />
        </header>
      )}
      <header className="dso-hud">
        <div className="dso-logo">
          <span className="dso-logo-mark">
            <OfficeIcon size={15} />
          </span>
          <span>智能体办公室</span>
        </div>
        <ProjectPicker
          teams={teams}
          teamsError={teamsError}
          leadId={leadId}
          current={snapshot}
          onPick={pickTeam}
          onCreated={(id) => {
            pickTeam(id);
            reloadTeams();
          }}
        />
        <div className="dso-stats">
          <Stat label="成员" value={members.length} />
          <Stat label="工作中" value={running} tone={running > 0 ? "good" : undefined} />
          <Stat label="交流" value={snapshot?.interactions.length ?? 0} />
        </div>
        <div style={{ flex: 1 }} />
        <div className="dso-tabs" role="tablist">
          {(["office", "gallery"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              className={mode === value ? "on" : ""}
              onClick={() => setMode(value)}
            >
              {value === "office" ? "办公室" : "角色图鉴"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="dso-icon-btn"
          title={fullscreen ? "退出全屏" : "浏览器全屏"}
          onClick={() => {
            if (document.fullscreenElement !== null) void document.exitFullscreen();
            else void document.documentElement.requestFullscreen?.();
          }}
        >
          {fullscreen ? "⤡" : "⤢"}
        </button>
        <button type="button" className="dso-btn ghost" title="回到原生对话界面" onClick={() => setOffice({ on: false, chatOpen: false })}>
          ← 返回对话界面
        </button>
      </header>
      <div className="dso-body">
        <aside className="dso-side">
          {member !== undefined && snapshot !== null ? (
            <MemberPanel
              api={api}
              member={member}
              running={isRunning(member)}
              snapshot={snapshot}
              onBack={() => setSelected(null)}
              onFocus={() => scene.current?.focus(member.id)}
              onOpen={() => openChat(member.id)}
              onOverride={async (patch) => {
                await fetch("/dsh-config/office/override", {
                  method: "POST",
                  headers: { "x-dsh-config": "agent-office", "content-type": "application/json" },
                  body: JSON.stringify({ member: member.id, ...patch }),
                });
                pollNow.current();
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
              onOpen={openChat}
            />
          )}
        </aside>
        <main className="dso-stage">
          <div ref={sceneHost} className="dso-scene" />
          {notice && <div className="dso-notice">{notice}</div>}
          {mode === "office" && <div className="dso-hint">拖动旋转 · 右键平移 · 滚轮缩放（缩到底继续滚看大楼外观） · 点击角色查看</div>}
        </main>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "good" | undefined }) {
  return (
    <span className={`dso-stat${tone ? ` ${tone}` : ""}`}>
      <b>{value}</b>
      <span>{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------- 项目选择

function ProjectPicker({
  teams,
  teamsError,
  leadId,
  current,
  onPick,
  onCreated,
}: {
  teams: TeamEntry[] | null;
  teamsError: string | null;
  leadId: string | null;
  current: { cwd?: string | undefined } | null;
  onPick: (leadId: string) => void;
  onCreated: (leadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const nameOf = useProjectName();
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const host = officeHost.current;
  const teamPaths = new Set((teams ?? []).map((t) => t.cwd).filter((c): c is string => c !== undefined));
  const free = open && host !== undefined ? host.listWorkspaces().filter((w) => !teamPaths.has(w.path)) : [];
  const currentTeam = (teams ?? []).find((t) => t.leadId === leadId);
  const path = currentTeam?.cwd ?? current?.cwd;
  const create = async (target: string) => {
    if (host === undefined) return;
    setBusy(target);
    setFailure(null);
    try {
      const id = await host.createTeam(target);
      onCreated(id);
      setOpen(false);
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div ref={rootRef} className="dso-picker-wrap">
      <button type="button" className={`dso-project${open ? " open" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="dso-project-flag" />
        <span className="dso-project-text">
          <b>{leadId === null ? "选择项目" : nameOf(path)}</b>
          {path && <small>{path}</small>}
        </span>
        <span className="dso-caret">▾</span>
      </button>
      {open && (
        <div className="dso-picker" role="dialog" aria-label="选择项目">
          <div className="dso-picker-head">
            <span>团队</span>
            {teamsError && <em title={teamsError}>⚠ {teamsError}</em>}
          </div>
          <div className="dso-cards">
            {teams === null ? (
              <div className="dso-empty">加载中…</div>
            ) : teams.length === 0 ? (
              <div className="dso-empty">还没有组建过团队</div>
            ) : (
              teams.map((team) => (
                <div
                  key={team.leadId}
                  role="button"
                  tabIndex={0}
                  className={`dso-team-card${team.leadId === leadId ? " on" : ""}`}
                  onClick={() => {
                    if (editing !== null) return;
                    onPick(team.leadId);
                    setOpen(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && editing === null) {
                      onPick(team.leadId);
                      setOpen(false);
                    }
                  }}
                >
                  <span className="dso-team-badge">{nameOf(team.cwd).slice(0, 1).toUpperCase()}</span>
                  <span className="dso-team-text">
                    {editing === team.leadId && team.cwd !== undefined ? (
                      <RenameInput
                        initial={nameOf(team.cwd)}
                        onDone={(value) => {
                          setEditing(null);
                          if (value === null || host === undefined || team.cwd === undefined) return;
                          // 清空 = 恢复成文件夹名
                          void host
                            .renameProject(team.cwd, value.length > 0 ? value : projectName(team.cwd))
                            .catch((reason) => setFailure(`改名失败：${String(reason)}`));
                        }}
                      />
                    ) : (
                      <b>{nameOf(team.cwd)}</b>
                    )}
                    <small>{team.cwd}</small>
                  </span>
                  {host !== undefined && team.cwd !== undefined && editing !== team.leadId && (
                    <button
                      type="button"
                      className="dso-edit"
                      title="给项目命名"
                      onClick={(event) => {
                        event.stopPropagation();
                        setEditing(team.leadId);
                      }}
                    >
                      ✎
                    </button>
                  )}
                  <span className="dso-team-meta">
                    <span className="dso-pill">{team.members} 人</span>
                    <small>{agoShort(team.lastActiveAt)}</small>
                  </span>
                </div>
              ))
            )}
          </div>
          <div className="dso-picker-head">
            <span>组建新团队</span>
            <button type="button" className="dso-link" onClick={() => setShowPrompt(!showPrompt)}>
              {showPrompt ? "收起提示词" : "查看提示词"}
            </button>
          </div>
          {showPrompt && <div className="dso-prompt">{TEAM_PROMPT}</div>}
          {host === undefined ? (
            <div className="dso-empty">工作区服务未就绪</div>
          ) : (
            <div className="dso-cards">
              {free.map((w) => (
                <div key={w.workspaceId} className="dso-team-card new">
                  <span className="dso-team-badge ghost">＋</span>
                  <span className="dso-team-text">
                    <b>{nameOf(w.path)}</b>
                    <small>{w.path}</small>
                  </span>
                  <button type="button" className="dso-btn primary sm" disabled={busy !== null} onClick={() => void create(w.path)}>
                    {busy === w.path ? "组建中…" : "组建团队"}
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="dso-team-card add"
                disabled={busy !== null}
                onClick={async () => {
                  const picked = await host.pickDirectory().catch(() => null);
                  if (picked === null) return;
                  const existing = (teams ?? []).find((t) => t.cwd === picked);
                  if (existing !== undefined) {
                    onPick(existing.leadId);
                    setOpen(false);
                    return;
                  }
                  await create(picked);
                }}
              >
                {busy !== null && !free.some((w) => w.path === busy) ? "组建中…" : "＋ 选择其他文件夹…"}
              </button>
            </div>
          )}
          {failure && <div className="dso-error">组建失败：{failure}</div>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 头像

function Avatar({ api, member, size }: { api: SceneModule | null; member: OfficeMember; size: number }) {
  const color = ROLE_COLOR[member.roleKind];
  const [src, setSrc] = useState<{ face: string; prop: string } | null>(null);
  useEffect(() => {
    if (api === null) return;
    // 渲染头像要几十毫秒：让出主线程再画，免得卡住面板切换。
    const handle = setTimeout(() => {
      try {
        setSrc({
          face: api.portrait(member.vendor, member.tier, member.roleKind, size * 2),
          prop: api.propIcon(member.roleKind, Math.round(size * 0.9)),
        });
      } catch (reason) {
        console.warn("[dsh-config] 头像渲染失败", reason);
        setSrc(null);
      }
    }, 16);
    return () => clearTimeout(handle);
  }, [api, member.vendor, member.tier, member.roleKind, size]);
  return (
    <span className="dso-avatar" style={{ width: size, height: size, ["--role" as string]: color }}>
      <span className="dso-avatar-frame">
        {src ? <img src={src.face} alt="" /> : <span className="dso-avatar-letter">{ROLE_LABEL[member.roleKind][0]}</span>}
      </span>
      {src && (
        <span className="dso-avatar-badge" title={ROLE_LABEL[member.roleKind]}>
          <img src={src.prop} alt="" />
        </span>
      )}
    </span>
  );
}

function statusOf(member: OfficeMember, running: boolean): { text: string; tone: string } {
  if (member.phase === "failed") return { text: "创建失败", tone: "bad" };
  if (member.phase === "provisioning") return { text: "入职中", tone: "info" };
  if (running) return { text: "工作中", tone: "good" };
  return { text: "空闲", tone: "idle" };
}

// ---------------------------------------------------------------- 成员列表

const KIND_LABEL: Record<OfficeInteraction["kind"], string> = {
  spawn: "招募",
  message: "消息",
  report: "完工汇报",
  instruction: "你的指令",
};
const KIND_COLOR: Record<OfficeInteraction["kind"], string> = {
  spawn: "#9a6cf0",
  message: "#5b7fd6",
  report: "#4fb85b",
  instruction: "#e3b546",
};

function InteractionItem({ item, names }: { item: OfficeInteraction; names: Map<string, OfficeMember> }) {
  const [open, setOpen] = useState(false);
  const from = item.from === USER_ID ? "你" : (names.get(item.from)?.name ?? "?");
  const to = names.get(item.to)?.name ?? "?";
  return (
    <li className={`dso-log${open ? " open" : ""}`} onClick={() => setOpen(!open)} style={{ ["--kind" as string]: KIND_COLOR[item.kind] }}>
      <div className="dso-log-head">
        <span className="dso-log-kind">{KIND_LABEL[item.kind]}</span>
        <b>{from}</b>
        <span className="dso-muted">→</span>
        <b>{to}</b>
        <span className="dso-muted dso-log-time">{clock(item.at)}</span>
      </div>
      {open ? <pre className="dso-log-full">{item.text}</pre> : <div className="dso-log-preview">{item.preview}</div>}
    </li>
  );
}

function TeamPanel({
  api,
  snapshot,
  isRunning,
  onPick,
  onOpen,
}: {
  api: SceneModule | null;
  snapshot: OfficeSnapshot | null;
  isRunning: (m: OfficeMember) => boolean;
  onPick: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  if (snapshot === null) return <div className="dso-empty">加载中…</div>;
  return (
    <>
      <h3 className="dso-section">
        <span>组长动态</span>
      </h3>
      <LeadPanel snapshot={snapshot} isRunning={isRunning} onOpen={onOpen} />
      <h3 className="dso-section">
        <span>队伍</span>
        <small>{snapshot.members.length}</small>
      </h3>
      <div className="dso-roster">
        {snapshot.members.map((m) => {
          const st = statusOf(m, isRunning(m));
          return (
            <div key={m.id} className={`dso-card ${st.tone}`} style={{ ["--role" as string]: ROLE_COLOR[m.roleKind] }}>
              <button type="button" className="dso-card-main" onClick={() => onPick(m.id)}>
                <Avatar api={api} member={m} size={44} />
                <span className="dso-card-text">
                  <span className="dso-card-name">
                    <b>{m.name}</b>
                    <span className="dso-role-tag">{ROLE_LABEL[m.roleKind]}</span>
                  </span>
                  <span className="dso-card-sub">
                    {VENDOR_LABEL[m.vendor]} {m.tier === "flagship" ? "★" : "⚡"} {TIER_LABEL[m.tier]}
                  </span>
                  <span className="dso-card-status">
                    <span className="dso-led" />
                    <span className="dso-ellipsis">{isRunning(m) && m.current ? m.current.label : st.text}</span>
                  </span>
                </span>
              </button>
              <button type="button" className="dso-card-chat" title="在右侧打开对话" onClick={() => onOpen(m.id)}>
                💬
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}

function since(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  return `${Math.floor(seconds / 3600)} 小时`;
}

/**
 * 组长动态（原先在 3D 场景里组长头顶的气泡与白板）：当前动作、待办进度、最近派活 / 发话。
 */
function LeadPanel({
  snapshot,
  isRunning,
  onOpen,
}: {
  snapshot: OfficeSnapshot;
  isRunning: (m: OfficeMember) => boolean;
  onOpen: (id: string) => void;
}) {
  const lead = snapshot.members.find((m) => m.role === "lead");
  // 每秒刷新「持续多久」
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  if (lead === undefined) return null;
  const running = isRunning(lead);
  const st = statusOf(lead, running);
  const names = new Map(snapshot.members.map((m) => [m.id, m]));
  const recent = snapshot.interactions.filter((i) => i.from === lead.id).slice(-4).reverse();
  const tasks = snapshot.tasks;
  const done = tasks.filter((t) => t.status === "completed").length;
  const order = { in_progress: 0, pending: 1, completed: 2 } as const;
  const sorted = [...tasks].sort((a, b) => order[a.status] - order[b.status]);
  const action = running
    ? lead.current === undefined || lead.current.kind === "thinking"
      ? "思考中…"
      : lead.current.label
    : st.text === "空闲"
      ? "待命"
      : st.text;
  return (
    <div className="dso-lead" style={{ ["--role" as string]: ROLE_COLOR.lead }}>
      <div className={`dso-lead-now ${st.tone}`}>
        <span className="dso-led" />
        <span className="dso-ellipsis">{action}</span>
        {running && lead.current && <small>{since(lead.current.since)}</small>}
        <button type="button" className="dso-lead-chat" title="与组长对话" onClick={() => onOpen(lead.id)}>
          💬
        </button>
      </div>
      {tasks.length > 0 && (
        <div className="dso-todo">
          <div className="dso-todo-head">
            <span>{snapshot.taskSource === "team" ? "共享任务" : "待办"}</span>
            <span className="dso-todo-bar">
              <span style={{ width: `${(done / tasks.length) * 100}%` }} />
            </span>
            <small>
              {done}/{tasks.length}
            </small>
          </div>
          <ul>
            {sorted.slice(0, 6).map((task) => (
              <li key={task.id} className={task.status}>
                <span className="dso-check">{task.status === "completed" ? "✓" : task.status === "in_progress" ? "▶" : ""}</span>
                <span className="dso-ellipsis">{task.subject}</span>
                {task.ownerName && <small>@{task.ownerName}</small>}
              </li>
            ))}
            {sorted.length > 6 && <li className="more">还有 {sorted.length - 6} 项…</li>}
          </ul>
        </div>
      )}
      {recent.length > 0 && (
        <ul className="dso-said">
          {recent.map((item) => (
            <li key={item.id} title={item.text}>
              <span className="dso-said-to">
                {item.kind === "spawn" ? "招募" : "→"} {names.get(item.to)?.name ?? "?"}
              </span>
              <span className="dso-ellipsis">{item.preview}</span>
              <small>{clock(item.at)}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 成员详情

const VENDORS: Vendor[] = ["claude", "gpt", "gemini", "grok", "kimi", "qwen", "glm", "deepseek", "other"];
const ROLES: RoleKind[] = ["frontend", "backend", "qa", "reviewer", "docs", "design", "devops", "data", "general"];

type OverridePatch = { role?: RoleKind | null; vendor?: Vendor | null; tier?: Tier | null };

/** 自绘下拉：第一项「自动」显示识别结果、选它恢复自动。 */
function Pick<T extends string>({
  label,
  value,
  detected,
  overridden,
  options,
  names,
  color,
  onChange,
}: {
  label: string;
  value: T;
  detected: T;
  overridden: boolean;
  options: readonly T[];
  names: Record<T, string>;
  color?: ((value: T) => string) | undefined;
  onChange: (value: T | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  const dot = (v: T) => (color ? <span className="dso-dot" style={{ background: color(v) }} /> : null);
  return (
    <div ref={ref} className="dso-pick">
      <span className="dso-pick-label">{label}</span>
      <button type="button" className={`dso-pick-btn${open ? " open" : ""}`} onClick={() => setOpen(!open)}>
        {dot(value)}
        <span>{names[value]}</span>
        {!overridden && <small>自动</small>}
        <span className="dso-caret">▾</span>
      </button>
      {open && (
        <div className="dso-pick-menu">
          <button
            type="button"
            className={!overridden ? "on" : ""}
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            {dot(detected)}自动（{names[detected]}）
          </button>
          {options.map((option) => (
            <button
              key={option}
              type="button"
              className={overridden && option === value ? "on" : ""}
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
            >
              {dot(option)}
              {names[option]}
            </button>
          ))}
        </div>
      )}
    </div>
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
  const st = statusOf(member, running);
  const names = new Map(snapshot.members.map((m) => [m.id, m]));
  const related = snapshot.interactions.filter((i) => i.from === member.id || i.to === member.id);
  const detected = member.detected ?? { vendor: member.vendor, tier: member.tier, roleKind: member.roleKind };
  const overridden = member.overridden ?? { role: false, vendor: false, tier: false };
  const stats: [string, ReactNode][] = [
    ["轮次", member.stats.turns],
    ["步骤", member.stats.steps],
    ["工具", member.stats.toolCalls],
    ["发出", member.stats.sent],
    ["收到", member.stats.received],
    ["输出词元", member.stats.outputTokens.toLocaleString()],
  ];
  return (
    <>
      <button type="button" className="dso-back" onClick={onBack}>
        ‹ 队伍
      </button>
      <div className={`dso-hero ${st.tone}`} style={{ ["--role" as string]: ROLE_COLOR[member.roleKind] }}>
        <Avatar api={api} member={member} size={76} />
        <div className="dso-hero-text">
          <div className="dso-hero-name">
            <b>{member.name}</b>
            <span className="dso-role-tag">{ROLE_LABEL[member.roleKind]}</span>
          </div>
          <div className="dso-card-status">
            <span className="dso-led" />
            {st.text}
          </div>
          <div className="dso-muted dso-ellipsis">
            {member.provider ?? "?"} / {member.model ?? "?"}
          </div>
        </div>
      </div>
      {member.description && <p className="dso-desc">{member.description}</p>}
      {running && member.current && <div className="dso-quest">▶ {member.current.label}</div>}
      {member.error && <div className="dso-error">{member.error}</div>}
      <div className="dso-actions">
        <button type="button" className="dso-btn primary" onClick={onOpen}>
          💬 打开对话
        </button>
        <button type="button" className="dso-btn" onClick={onFocus}>
          ◎ 镜头对准
        </button>
      </div>
      <div className="dso-statgrid">
        {stats.map(([label, value]) => (
          <div key={label}>
            <b>{value}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <h3 className="dso-section">
        <span>角色设定</span>
      </h3>
      <div className="dso-picks">
        {member.role !== "lead" && (
          <Pick
            label="岗位"
            value={member.roleKind}
            detected={detected.roleKind}
            overridden={overridden.role}
            options={ROLES}
            names={ROLE_LABEL}
            color={(r) => ROLE_COLOR[r]}
            onChange={(role) => void onOverride({ role })}
          />
        )}
        <Pick
          label="人设"
          value={member.vendor}
          detected={detected.vendor}
          overridden={overridden.vendor}
          options={VENDORS}
          names={VENDOR_LABEL}
          onChange={(vendor) => void onOverride({ vendor })}
        />
        <Pick
          label="档位"
          value={member.tier}
          detected={detected.tier}
          overridden={overridden.tier}
          options={["flagship", "fast"] as Tier[]}
          names={TIER_LABEL}
          onChange={(tier) => void onOverride({ tier })}
        />
      </div>
      {related.length > 0 && (
        <>
          <h3 className="dso-section">
            <span>相关交流</span>
            <small>{related.length}</small>
          </h3>
          <ul className="dso-logs">
            {[...related].reverse().slice(0, 30).map((item) => (
              <InteractionItem key={item.id} item={item} names={names} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}
