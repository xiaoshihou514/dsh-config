/**
 * 智能体办公室（办公室模式）。
 *
 * 挂在 `shell.overlay`。默认铺满窗口：左栏成员 / 详情 / 交流，中间 3D 场景，顶部 HUD。
 * 点成员「打开对话」：切换当前会话，覆盖层收成左侧成员栏，3D 场景隐藏，右边是原生
 * 对话（中央列靠左内边距让出成员栏）；Esc 或「回到办公室」收起对话。开关与正在看的
 * 团队持久化，刷新后直接回到办公室。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { UsageDialog } from "../UsageTrigger.tsx";
import { ROLE_COLOR, ROLE_LABEL, TIER_LABEL, VENDOR_LABEL } from "../../office/classify.ts";
import type { OfficeInteraction, OfficeMember, OfficeSnapshot, RoleKind, Tier, Vendor } from "../../office/types.ts";
import { USER_ID } from "../../office/types.ts";
import { currentSession, getOffice, setOffice, useOffice } from "./store.ts";
import { CSS } from "./styles.ts";
import { useSoloPick, useSoloSnapshot } from "./shared.ts";
import { bossSnapshot, useLeadFacts, useLeadPick } from "./boss.ts";
import { BOSS_LABEL } from "../../office/boss.ts";

type Selector<T> = (selector: (state: any) => T) => T;

export interface SceneModule {
  portrait(vendor: Vendor, tier: Tier, role: RoleKind, size?: number): string;
  propIcon(role: RoleKind, size?: number): string;
  createOfficeScene(
    container: HTMLElement,
    options: { onSelect(id: string | null): void; layout?: "ring" | "rows" | "boss" },
  ): {
    update(snapshot: OfficeSnapshot, live: Record<string, boolean>): void;
    select(id: string | null): void;
    focus(id: string): void;
    setMode(mode: "office" | "gallery"): void;
    setPaused?(paused: boolean): void;
    setAttention?(id: string | null, kind?: "report" | "error"): void;
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

/**
 * 入口注入：打开原生设置（`ctx.shortcuts.invoke("settings.open", …)`）。设置弹窗挂在 body、
 * 层级 1000，盖在办公室覆盖层（40）之上，所以不必离开办公室。
 */
export const settingsHost: { current: { open(): void } | undefined } = { current: undefined };

/** 办公室里开着的弹窗数（用量）：开着时 Esc 交给弹窗，不收起对话。 */
let dialogsOpen = 0;
/** 原生弹窗（设置等）开着：它们自己处理 Esc。 */
const nativeModalOpen = () => document.querySelector("[data-shortcut-modal]") !== null;

/**
 * HUD「设置」：优先走入口注入的命令；没有时点原生侧边栏的设置按钮（被覆盖层挡住也能点）；
 * 再不行就退回对话界面，让用户自己点。
 */
function openNativeSettings(): void {
  try {
    if (settingsHost.current !== undefined) {
      settingsHost.current.open();
      return;
    }
  } catch {
    // 命令被拦（如另有弹窗）时走下面的退路
  }
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"][class*="_trigger"]');
  if (trigger !== null) {
    trigger.click();
    return;
  }
  setOffice({ on: false, chatOpen: false });
}

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

/** HUD 图标：与 OfficeIcon 同一套 16 格、1.3 线宽的描边画法。 */
function UsageIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <path d="M1.8 14h12.4" />
      <rect x="3" y="8.6" width="2.4" height="5.4" rx=".5" />
      <rect x="6.8" y="5.6" width="2.4" height="8.4" rx=".5" />
      <rect x="10.6" y="2.6" width="2.4" height="11.4" rx=".5" />
    </svg>
  );
}

/** 齿轮：8 齿，外圈齿顶 / 齿根交替。 */
const GEAR_PATH = (() => {
  const points: string[] = [];
  const teeth = 8;
  for (let i = 0; i < teeth * 4; i += 1) {
    const a = (i / (teeth * 4)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 4 === 1 || i % 4 === 2 ? 6.4 : 4.9;
    points.push(`${(8 + Math.cos(a) * r).toFixed(2)},${(8 + Math.sin(a) * r).toFixed(2)}`);
  }
  return `M${points.join("L")}Z`;
})();

function SettingsIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <path d={GEAR_PATH} />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

function FullscreenIcon({ exit, size = 14 }: { exit: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      {exit ? (
        <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" />
      ) : (
        <path d="M2 6V2h4M10 2h4v4M2 10v4h4M14 10v4h-4" />
      )}
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
  /** 同一文件夹里被这个团队取代的旧 Lead（重新组队后）。 */
  readonly replaces?: readonly string[];
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
      if (dialogsOpen > 0 || nativeModalOpen()) return;
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
  /** 看哪个办公室：当前团队、所有项目单智能体的共享办公室、各团队组长来汇报的老板办公室。 */
  const [view, setView] = useState<"team" | "shared" | "boss">("team");
  const shared = view === "shared";
  const bossView = view === "boss";
  const [api, setApi] = useState<SceneModule | null>(null);
  /** 场景每重建一次加一：新场景要立刻同步模式、暂停、提醒与快照（setApi 传同一个模块不会触发重渲染）。 */
  const [sceneVersion, setSceneVersion] = useState(0);
  const sceneHost = useRef<HTMLDivElement>(null);
  const scene = useRef<ReturnType<SceneModule["createOfficeScene"]> | null>(null);
  const pollNow = useRef<() => void>(() => {});
  const rootRef = useRef<HTMLDivElement>(null);

  // 选团队：记录的（同文件夹重新组队后换成新团队）→ 当前会话所在团队 → 最近活跃的 →
  // 当前会话本身（接口不可用时）
  const leadId = useMemo(() => {
    if (storedLead !== null) return teams?.find((t) => t.replaces?.includes(storedLead))?.leadId ?? storedLead;
    if (teams === null) return null;
    const { sessionId, parentSessionId } = currentSession();
    const inTeams = (id: string | undefined) => (id !== undefined && teams.some((t) => t.leadId === id) ? id : undefined);
    return inTeams(parentSessionId) ?? inTeams(sessionId) ?? teams[0]?.leadId ?? parentSessionId ?? sessionId ?? null;
  }, [storedLead, teams]);
  useEffect(() => {
    if (leadId !== null && leadId !== storedLead) setOffice({ lead: leadId });
  }, [storedLead, leadId]);

  // 共享办公室：组建过团队的会话都算组长（刚组建还没招人的也排除）
  const leads = useMemo(() => new Set((teams ?? []).flatMap((t) => [t.leadId, ...(t.replaces ?? [])])), [teams]);
  // 单智能体一直取（老板办公室的单智能体汇报、HUD 角标要用）；在共享办公室里轮询更勤
  const soloPick = useSoloPick(true, useSessions as never, leads);
  const nameOfProject = useProjectName();
  const solo = useSoloSnapshot(true, soloPick.ids, nameOfProject, shared);
  // 老板办公室：一直轮询（HUD 角标要用），在老板办公室里更勤
  const leadPick = useLeadPick(useSessions as never, leads);
  const leadFacts = useLeadFacts(leadPick, bossView);

  const viewIds = shared ? (solo.snapshot?.members.map((m) => m.id) ?? []) : (snapshot?.members.map((m) => m.id) ?? []);
  const bossIds = [...(leadFacts.leads ?? []).flatMap((f) => [f.member.id, ...f.memberIds]), ...soloPick.ids];
  const idKey = [...viewIds, "|", ...bossIds].join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const memberIds = useMemo(() => [...new Set([...viewIds, ...bossIds])], [idKey]);
  const live = useLive(memberIds, useSessions, useSessionStatus);
  // 看过的汇报离开老板办公室：已看过记录变化时（useAttention 订阅了它）会重渲染，这里每次现算
  const boss = bossSnapshot(leadFacts.leads, live, nameOfProject, solo.snapshot?.members ?? null, readAcks());
  const bossPending = boss?.members.filter((m) => m.boss === "report" || m.boss === "error").length ?? 0;
  /** 场景与左栏显示的那份快照。 */
  const shown = shared ? solo.snapshot : bossView ? boss : snapshot;

  useEffect(() => {
    setSnapshot(null);
    setSelected(null);
    setError(null);
  }, [leadId]);
  useEffect(() => setSelected(null), [view]);
  /** 场景随「团队 / 共享办公室 / 老板办公室」重建（布局不同）。 */
  const sceneKey = shared ? "__shared__" : bossView ? "__boss__" : leadId;

  // 轮询快照
  useEffect(() => {
    if (leadId === null) return;
    let stopped = false;
    let etag = "";
    let missing = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/dsh-config/office?lead=${encodeURIComponent(leadId)}`, {
          headers: { "x-dsh-config": "agent-office", ...(etag ? { "if-none-match": etag } : {}) },
          cache: "no-store",
        });
        missing = response.status === 404 ? missing + 1 : 0;
        // 记住的组长会话被删了：连续几次找不到就忘掉它，回到默认选择（刚建的会话可能晚一点落盘）
        if (missing >= 3 && getOffice().lead === leadId) {
          missing = 0;
          setOffice({ lead: null });
        }
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

  // 场景（切换团队、切到共享办公室时重建）
  useEffect(() => {
    if (sceneKey === null) return;
    let disposed = false;
    loadScene()
      .then((module) => {
        if (disposed || sceneHost.current === null) return;
        scene.current = module.createOfficeScene(sceneHost.current, {
          onSelect: (id) => setSelected(id),
          layout: sceneKey === "__shared__" ? "rows" : sceneKey === "__boss__" ? "boss" : "ring",
        });
        setApi(module);
        setSceneVersion((v) => v + 1);
      })
      .catch((reason) => setSceneError(String(reason)));
    return () => {
      disposed = true;
      scene.current?.dispose();
      scene.current = null;
    };
  }, [sceneKey]);

  const nameOf = nameOfProject;
  const displayName = snapshot === null ? undefined : nameOf(snapshot.cwd);
  useEffect(() => {
    if (shown !== null) scene.current?.update(shared || bossView ? shown : { ...shown, projectName: displayName }, live);
  });
  useEffect(() => scene.current?.select(selected), [selected, sceneVersion]);
  useEffect(() => scene.current?.setMode(mode), [mode, sceneVersion]);
  useEffect(() => scene.current?.setPaused?.(chatOpen), [chatOpen, sceneVersion]);

  const members = shown?.members ?? [];
  const isRunning = (m: OfficeMember) => live[m.id] ?? m.busy;
  const running = members.filter(isRunning).length;
  const member = members.find((m) => m.id === selected);
  // 醒目提醒只看当前团队（共享办公室里不打扰）
  const teamRunning = view !== "team" ? (snapshot?.members ?? []).filter((m) => m.busy).length : running;
  const attention = useAttention(snapshot, leadId, teamRunning, chatOpen);
  const unreadOf = useUnread(snapshot, chatOpen);
  const unread = (id: string) => unreadOf(id) || (attention !== null && id === attention.leadId);
  useEffect(
    () => scene.current?.setAttention?.(view !== "team" ? null : (attention?.leadId ?? null), attention?.kind),
    [attention?.leadId, attention?.kind, attention?.at, sceneVersion, view],
  );
  const openChat = (id: string) => {
    if (bossView) {
      // 打开组长对话就算看过这次汇报（团队办公室的横幅同步消失）
      const lead = boss?.members.find((m) => m.id === id);
      if (lead?.lastTurn !== undefined && lead.boss !== "waiting") acknowledge(id, lead.lastTurn.at);
      markRead(id);
    }
    if (shared || bossView) {
      // 单智能体：直接打开它自己的会话
      setOffice({ chatOpen: true });
      setTimeout(() => {
        officeHost.current?.showConversation();
        if (currentSession().sessionId !== id) officeHost.current?.openSession(id, id);
      }, 0);
      return;
    }
    if (leadId === null) return;
    // 打开组长对话就算看过这次汇报
    if (id === leadId && attention !== null) acknowledge(leadId, attention.at);
    markRead(id);
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
    setView("team");
    setOffice({ lead: id });
    officeHost.current?.openSession(id, id);
  };

  const [fullscreen, setFullscreen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  useEffect(() => {
    if (!usageOpen) return;
    dialogsOpen += 1;
    return () => {
      dialogsOpen -= 1;
    };
  }, [usageOpen]);
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const notice = sceneError
    ? `场景加载失败：${sceneError}`
    : bossView
      ? leadFacts.error
        ? `读取老板办公室失败：${leadFacts.error}`
        : boss === null
          ? "正在进入老板办公室…"
          : boss.members.length === 0
            ? "暂无汇报：组长汇报完毕、出错停下或派完活等组员时会来这里"
            : null
    : shared
      ? solo.error
        ? `读取共享办公室失败：${solo.error}`
        : solo.snapshot === null
          ? "正在进入共享办公室…"
          : solo.snapshot.members.length === 0
            ? "共享办公室暂时没人：正在运行、或 24 小时内活跃过的单智能体才会入座"
            : null
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
        {bossView ? (
          <div className="dso-stats">
            <Stat label="待处理" value={bossPending} tone={bossPending > 0 ? "good" : undefined} />
            <Stat label="等组员" value={(boss?.members.length ?? 0) - bossPending} />
          </div>
        ) : shared ? (
          <div className="dso-stats">
            <Stat label="在座" value={members.length} />
            <Stat label="工作中" value={running} tone={running > 0 ? "good" : undefined} />
            {soloPick.overflow > 0 && <Stat label="人未入座（满 24 人）" value={`+${soloPick.overflow}`} />}
          </div>
        ) : (
          <div className="dso-stats">
            <Stat label="成员" value={members.length} />
            <Stat label="工作中" value={running} tone={running > 0 ? "good" : undefined} />
            <Stat label="交流" value={snapshot?.interactions.length ?? 0} />
          </div>
        )}
        <div style={{ flex: 1 }} />
        <div className="dso-tabs" role="tablist">
          {(
            [
              ["team", "办公室"],
              ["shared", "共享办公室"],
              ["boss", "老板办公室"],
              ["gallery", "角色图鉴"],
            ] as const
          ).map(([value, label]) => {
            const on = value === "gallery" ? mode === "gallery" : mode === "office" && view === value;
            return (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={on}
                className={on ? "on" : ""}
                title={
                  value === "shared"
                    ? "所有项目的单智能体：正在运行或 24 小时内活跃的入座"
                    : value === "boss"
                      ? "各团队组长汇报完毕、出错停下或派完活等组员时来这里"
                      : undefined
                }
                onClick={() => {
                  if (value === "gallery") setMode("gallery");
                  else {
                    setView(value);
                    setMode("office");
                  }
                }}
              >
                {label}
                {value === "boss" && bossPending > 0 && <span className="dso-tab-badge">{bossPending}</span>}
              </button>
            );
          })}
        </div>
        <button type="button" className="dso-btn dso-hud-entry" title="查看词元用量与费用" onClick={() => setUsageOpen(true)}>
          <span className="dso-hud-ico usage">
            <UsageIcon size={13} />
          </span>
          用量
        </button>
        <button type="button" className="dso-btn dso-hud-entry" title="打开设置（不离开办公室）" onClick={openNativeSettings}>
          <span className="dso-hud-ico settings">
            <SettingsIcon size={13} />
          </span>
          设置
        </button>
        {/* 用量弹窗挂到 body：覆盖层收成左侧成员栏时也能铺满窗口 */}
        {usageOpen && createPortal(<UsageDialog open onClose={() => setUsageOpen(false)} />, document.body)}
        <button
          type="button"
          className="dso-icon-btn"
          title={fullscreen ? "退出全屏" : "浏览器全屏"}
          onClick={() => {
            if (document.fullscreenElement !== null) void document.exitFullscreen();
            else void document.documentElement.requestFullscreen?.();
          }}
        >
          <FullscreenIcon exit={fullscreen} />
        </button>
        <button type="button" className="dso-btn ghost" title="回到原生对话界面" onClick={() => setOffice({ on: false, chatOpen: false })}>
          ← 返回对话界面
        </button>
      </header>
      <div className="dso-body">
        <aside className="dso-side">
          {bossView ? (
            <BossPanel
              api={api}
              snapshot={boss}
              selected={selected}
              onPick={(id) => {
                setSelected(id);
                setMode("office");
                scene.current?.focus(id);
              }}
              onOpen={openChat}
              onDismiss={(id) => {
                const m = boss?.members.find((x) => x.id === id);
                if (m?.lastTurn !== undefined) acknowledge(id, m.lastTurn.at);
                markRead(id);
              }}
            />
          ) : shared ? (
            <SharedPanel
              api={api}
              snapshot={solo.snapshot}
              overflow={soloPick.overflow}
              selected={selected}
              isRunning={isRunning}
              onPick={(id) => {
                setSelected(id);
                setMode("office");
                scene.current?.focus(id);
              }}
              onOpen={openChat}
            />
          ) : member !== undefined && snapshot !== null ? (
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
              onModelChanged={() => pollNow.current()}
            />
          ) : (
            <TeamPanel
              api={api}
              attention={attention?.kind ?? null}
              unread={unread}
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
          {mode === "office" && view === "team" && attention !== null && (
            <AttentionBanner
              attention={attention}
              onBoss={() => {
                setView("boss");
                setMode("office");
              }}
              onOpen={() => openChat(attention.leadId)}
              onDismiss={() => {
                acknowledge(attention.leadId, attention.at);
                markRead(attention.leadId);
              }}
            />
          )}
          {mode === "office" && <div className="dso-hint">点击角色查看详情</div>}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 未读

/**
 * 未读只看组长（组员只和组长交互，你只需关注组长的汇报）：组长最近一轮结束（说完了一段话）
 * 晚于你上次打开他的对话，就算有未读。
 * 按组长会话 id 记 { seen, latest }（localStorage `dsh-config:office-reads`，格式 `{ v: 2, leads }`）：
 * latest 是见过的最近一轮结束时间（之后开了新一轮快照里就没有 lastTurn 了，所以要自己记住），
 * seen 是上次打开对话时的 latest。第一次见到某个组长时以当时为基线，不把旧消息都算成未读。
 * 旧格式（每个成员一条）直接忽略。
 */
const READS_KEY = "dsh-config:office-reads";
type Reads = Record<string, { seen: number; latest: number }>;
const readListeners = new Set<() => void>();
function loadReads(): Reads {
  try {
    const parsed = JSON.parse(localStorage.getItem(READS_KEY) ?? "{}") as { v?: unknown; leads?: Reads };
    return parsed.v === 2 && parsed.leads !== undefined ? parsed.leads : {};
  } catch {
    return {};
  }
}
function saveReads(reads: Reads): void {
  try {
    localStorage.setItem(READS_KEY, JSON.stringify({ v: 2, leads: reads }));
  } catch {
    // 隐私模式：只在内存里
  }
  for (const listener of readListeners) listener();
}
let readsLoaded: Reads | undefined;
/** 第一次用到时才从 localStorage 读。 */
function reads(): Reads {
  readsLoaded ??= loadReads();
  return readsLoaded;
}

/** 打开某人的对话：他目前说过的都算看过了（只有组长有记录，其他人是空操作）。 */
function markRead(id: string): void {
  const entry = reads()[id];
  if (entry === undefined || entry.seen >= entry.latest) return;
  readsLoaded = { ...reads(), [id]: { ...entry, seen: entry.latest } };
  saveReads(readsLoaded);
}

function useUnread(snapshot: OfficeSnapshot | null, chatOpen: boolean): (id: string) => boolean {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((v) => v + 1);
    readListeners.add(listener);
    return () => {
      readListeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    if (snapshot === null) return;
    const viewing = chatOpen ? currentSession().sessionId : undefined;
    let next: Reads | undefined;
    for (const m of snapshot.members) {
      if (m.role !== "lead") continue;
      const at = m.lastTurn?.at;
      const entry = (next ?? reads())[m.id];
      let updated = entry;
      if (entry === undefined) updated = { seen: at ?? 0, latest: at ?? 0 };
      else if (at !== undefined && at > entry.latest) updated = { ...entry, latest: at };
      // 对话正开着这个人：边说边看，不算未读
      if (updated !== undefined && m.id === viewing && updated.seen < updated.latest) updated = { ...updated, seen: updated.latest };
      if (updated !== entry && updated !== undefined) {
        next ??= { ...reads() };
        next[m.id] = updated;
      }
    }
    if (next !== undefined) {
      readsLoaded = next;
      saveReads(next);
    }
  }, [snapshot, chatOpen]);
  return (id) => {
    const entry = reads()[id];
    return entry !== undefined && entry.latest > entry.seen;
  };
}

// ---------------------------------------------------------------- 醒目提醒

interface Attention {
  readonly leadId: string;
  readonly kind: "report" | "error";
  /** 组长这一轮结束的时间（看过 / 关掉提醒时记下它）。 */
  readonly at: number;
  readonly reason?: string | undefined;
}

const ACK_KEY = "dsh-config:office-ack";
const ackListeners = new Set<() => void>();
function readAcks(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(ACK_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}
/** 记下「这次汇报已看过」：同一轮结束不再提醒（刷新后也记得）。 */
function acknowledge(leadId: string, at: number): void {
  const acks = readAcks();
  if ((acks[leadId] ?? 0) >= at) return;
  acks[leadId] = at;
  try {
    localStorage.setItem(ACK_KEY, JSON.stringify(acks));
  } catch {
    // 隐私模式：只在本次会话里生效
  }
  for (const listener of ackListeners) listener();
}

/**
 * 什么时候提醒：组长这一轮已经结束（快照里的 lastTurn），之后你没再发过指令，
 * 整个团队也都停下来了（还有人在干活时组长会被组员的汇报自动叫醒，不必打扰你），
 * 并且这次汇报还没看过。条件需持续 2 秒才亮，免得组员汇报接力时闪一下。
 * 对话正开着组长会话时，视为已经在看了。
 */
function useAttention(snapshot: OfficeSnapshot | null, leadId: string | null, running: number, chatOpen: boolean): Attention | null {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((v) => v + 1);
    ackListeners.add(listener);
    return () => {
      ackListeners.delete(listener);
    };
  }, []);
  const lead = snapshot?.members.find((m) => m.role === "lead");
  const turn = lead?.lastTurn;
  const lastInstruction = Math.max(
    0,
    ...(snapshot?.interactions ?? []).filter((i) => i.kind === "instruction" && i.to === lead?.id).map((i) => i.at),
  );
  const acked = leadId === null ? 0 : (readAcks()[leadId] ?? 0);
  const candidate: Attention | null =
    leadId !== null && lead !== undefined && turn !== undefined && running === 0 && turn.at > lastInstruction && turn.at > acked
      ? { leadId, kind: turn.ok ? "report" : "error", at: turn.at, reason: turn.reason }
      : null;
  const key = candidate === null ? "" : `${candidate.leadId}:${candidate.kind}:${candidate.at}`;
  const [stable, setStable] = useState<Attention | null>(null);
  useEffect(() => {
    if (candidate === null) {
      setStable(null);
      return;
    }
    if (chatOpen && currentSession().sessionId === candidate.leadId) {
      acknowledge(candidate.leadId, candidate.at);
      return;
    }
    const timer = setTimeout(() => setStable(candidate), 2000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, chatOpen]);
  return candidate === null ? null : stable;
}

function AttentionBanner({
  attention,
  onOpen,
  onBoss,
  onDismiss,
}: {
  attention: Attention;
  onOpen: () => void;
  onBoss: () => void;
  onDismiss: () => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((v) => v + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  const error = attention.kind === "error";
  return (
    <div className={`dso-attn${error ? " error" : ""}`} role="status">
      <span className="dso-attn-bang">!</span>
      <span className="dso-attn-text">
        <b>{error ? "组长这一轮出错停下了" : "组长汇报完毕，在等你回复"}</b>
        <small>
          {agoShort(attention.at)}
          {error && attention.reason ? ` · ${attention.reason}` : ""}
          {!error ? " · 团队成员都已停下" : ""}
        </small>
      </span>
      <button type="button" className="dso-btn primary sm" onClick={onOpen}>
        {error ? "去看看" : "查看汇报"}
      </button>
      <button type="button" className="dso-btn ghost sm" title="所有团队的汇报都在老板办公室" onClick={onBoss}>
        去老板办公室
      </button>
      <button type="button" className="dso-attn-x" title="知道了" onClick={onDismiss}>
        ✕
      </button>
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

/**
 * 老板办公室左栏：待处理（组长与单智能体的汇报 / 出错，等得最久的在前）、等组员的组长；
 * 💬 打开对话、✓ 知道了（都记为看过，离开老板办公室）。
 */
function BossPanel({
  api,
  snapshot,
  selected,
  onPick,
  onOpen,
  onDismiss,
}: {
  api: SceneModule | null;
  snapshot: OfficeSnapshot | null;
  selected: string | null;
  onPick: (id: string) => void;
  onOpen: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  if (snapshot === null) return <div className="dso-empty">加载中…</div>;
  const pending = snapshot.members.filter((m) => m.boss !== "waiting");
  const waiting = snapshot.members.filter((m) => m.boss === "waiting");
  const card = (m: OfficeMember) => (
    <div
      key={m.id}
      className={`dso-card ${m.boss === "error" ? "bad" : m.boss === "report" ? "good" : "idle"}${m.id === selected ? " sel" : ""}`}
      style={{ ["--role" as string]: ROLE_COLOR.lead }}
    >
      <button type="button" className="dso-card-main" onClick={() => onPick(m.id)}>
        <Avatar api={api} member={m} size={44} />
        <span className="dso-card-text">
          <span className="dso-card-name">
            <b>{m.project ?? "项目"}</b>
            <span className="dso-role-tag">
              {m.role === "lead" ? "组长" : "单智能体"} · {VENDOR_LABEL[m.vendor]}
            </span>
          </span>
          <span className="dso-card-sub dso-ellipsis" title={m.description}>
            {m.description ?? "组长"}
          </span>
          <span className="dso-card-status">
            <span className="dso-led" />
            <span className="dso-ellipsis">
              {m.boss === undefined ? "" : BOSS_LABEL[m.boss]}
              {m.lastTurn !== undefined && m.boss !== "waiting" ? ` · ${agoShort(m.lastTurn.at)}` : ""}
            </span>
          </span>
        </span>
      </button>
      <span className="dso-card-acts">
        <button type="button" className="dso-card-chat" title="打开对话" onClick={() => onOpen(m.id)}>
          💬
        </button>
        {m.boss !== "waiting" && (
          <button type="button" className="dso-card-chat" title="知道了（不打开对话，从老板办公室移走）" onClick={() => onDismiss(m.id)}>
            ✓
          </button>
        )}
      </span>
    </div>
  );
  return (
    <>
      <h3 className="dso-section">
        <span>待处理</span>
        <small>{pending.length}</small>
      </h3>
      {pending.length === 0 ? <div className="dso-empty">暂无汇报</div> : <div className="dso-roster">{pending.map(card)}</div>}
      <h3 className="dso-section dso-shared-project">
        <span>派完活、等组员</span>
        <small>{waiting.length}</small>
      </h3>
      {waiting.length === 0 ? <div className="dso-empty">没有</div> : <div className="dso-roster">{waiting.map(card)}</div>}
    </>
  );
}

/** 共享办公室左栏：按项目分组的单智能体，点卡片定位、💬 打开它的对话。 */
function SharedPanel({
  api,
  snapshot,
  overflow,
  selected,
  isRunning,
  onPick,
  onOpen,
}: {
  api: SceneModule | null;
  snapshot: OfficeSnapshot | null;
  overflow: number;
  selected: string | null;
  isRunning: (m: OfficeMember) => boolean;
  onPick: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  if (snapshot === null) return <div className="dso-empty">加载中…</div>;
  const groups = new Map<string, OfficeMember[]>();
  for (const m of snapshot.members) {
    const key = m.project ?? "未知项目";
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  return (
    <>
      <h3 className="dso-section">
        <span>共享办公室</span>
        <small>{snapshot.members.length}</small>
      </h3>
      <p className="dso-shared-hint">
        所有项目的单智能体：正在运行、或 24 小时内活跃过的入座{overflow > 0 ? `（满 24 人，另有 ${overflow} 人未入座）` : ""}。
      </p>
      {snapshot.members.length === 0 && <div className="dso-empty">暂时没人</div>}
      {[...groups].map(([project, list]) => (
        <div key={project}>
          <h3 className="dso-section dso-shared-project">
            <span>📁 {project}</span>
            <small>{list.length}</small>
          </h3>
          <div className="dso-roster">
            {list.map((m) => {
              const st = statusOf(m, isRunning(m));
              return (
                <div
                  key={m.id}
                  className={`dso-card ${st.tone}${m.id === selected ? " sel" : ""}`}
                  style={{ ["--role" as string]: ROLE_COLOR[m.roleKind] }}
                >
                  <button type="button" className="dso-card-main" onClick={() => onPick(m.id)}>
                    <Avatar api={api} member={m} size={44} />
                    <span className="dso-card-text">
                      <span className="dso-card-name">
                        <b>{VENDOR_LABEL[m.vendor]}</b>
                        <span className="dso-role-tag">{m.tier === "flagship" ? "★ 旗舰" : "⚡ 快速"}</span>
                      </span>
                      <span className="dso-card-sub dso-ellipsis" title={m.description}>
                        {m.description ?? m.name}
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
        </div>
      ))}
    </>
  );
}

function TeamPanel({
  api,
  attention,
  unread,
  snapshot,
  isRunning,
  onPick,
  onOpen,
}: {
  api: SceneModule | null;
  attention: "report" | "error" | null;
  unread: (id: string) => boolean;
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
      <LeadPanel
        snapshot={snapshot}
        attention={attention}
        unread={snapshot.members.some((m) => m.role === "lead" && unread(m.id))}
        isRunning={isRunning}
        onOpen={onOpen}
      />
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
  attention,
  unread,
  isRunning,
  onOpen,
}: {
  snapshot: OfficeSnapshot;
  attention: "report" | "error" | null;
  unread: boolean;
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
    : attention === "report"
      ? "汇报完毕，等你回复"
      : attention === "error"
        ? "这一轮出错停下了"
        : st.text === "空闲"
          ? "待命"
          : st.text;
  return (
    <div className="dso-lead" style={{ ["--role" as string]: ROLE_COLOR.lead }}>
      <div className={`dso-lead-now ${attention !== null && !running ? `attn ${attention}` : st.tone}`}>
        <span className="dso-led" />
        <span className="dso-ellipsis">{action}</span>
        {running && lead.current && <small>{since(lead.current.since)}</small>}
        <button type="button" className="dso-lead-chat" title={unread ? "组长有新消息 · 打开对话" : "与组长对话"} onClick={() => onOpen(lead.id)}>
          💬
          {unread && <span className="dso-dot-unread" />}
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

// ---------------------------------------------------------------- 成员模型

interface CatalogGroup {
  readonly provider: string;
  readonly name: string;
  readonly models: readonly { id: string; name: string }[];
  readonly error?: string;
}

const officeHeaders = { "x-dsh-config": "agent-office" } as const;

/** 关掉：点外面。 */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  return ref;
}

/**
 * 手动换模型：原生选择器对子智能体会话禁用，这里经宿主接口给成员会话记一条模型选择
 * （下一步生效、续跑沿用，不改默认模型）。
 */
function ModelPicks({ member, onChanged }: { member: OfficeMember; onChanged: () => void }) {
  const [open, setOpen] = useState<"model" | "effort" | null>(null);
  const [groups, setGroups] = useState<CatalogGroup[] | null>(null);
  const [efforts, setEfforts] = useState<{ list: { id: string; name: string }[]; fallback?: string } | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const modelRef = useDismiss(open === "model", () => setOpen(null));
  const effortRef = useDismiss(open === "effort", () => setOpen(null));
  const { provider, model } = member;

  useEffect(() => {
    if (open !== "model" || groups !== null) return;
    fetch("/dsh-config/office/models", { headers: officeHeaders, cache: "no-store" })
      .then((r) => r.json() as Promise<{ ok: boolean; groups?: CatalogGroup[]; error?: string }>)
      .then((body) => (body.ok ? setGroups(body.groups ?? []) : setFailure(body.error ?? "读取模型列表失败")))
      .catch((reason) => setFailure(String(reason)));
  }, [open, groups]);

  useEffect(() => {
    setEfforts(null);
    if (provider === undefined || model === undefined) return;
    let stale = false;
    const params = new URLSearchParams({ provider, model });
    fetch(`/dsh-config/office/models?${params}`, { headers: officeHeaders, cache: "no-store" })
      .then((r) => r.json() as Promise<{ ok: boolean; efforts?: { id: string; name: string }[]; defaultEffort?: string }>)
      .then((body) => {
        if (!stale && body.ok) setEfforts({ list: body.efforts ?? [], ...(body.defaultEffort ? { fallback: body.defaultEffort } : {}) });
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [provider, model]);

  const apply = async (next: { provider: string; model: string; reasoningEffort?: string }) => {
    setOpen(null);
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch("/dsh-config/office/model", {
        method: "POST",
        headers: { ...officeHeaders, "content-type": "application/json" },
        body: JSON.stringify({ member: member.id, ...next }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || body.ok !== true) setFailure(body.error ?? `HTTP ${response.status}`);
      onChanged();
    } catch (reason) {
      setFailure(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const q = query.trim().toLowerCase();
  const shown = (groups ?? [])
    .map((g) => ({
      ...g,
      models: g.models.filter((m) => q === "" || `${g.provider} ${g.name} ${m.id} ${m.name}`.toLowerCase().includes(q)),
    }))
    .filter((g) => g.models.length > 0 || (q === "" && g.error !== undefined));
  const effortName = (id: string | undefined) => efforts?.list.find((e) => e.id === id)?.name ?? id;
  const unknown = provider === undefined || model === undefined;

  return (
    <>
      <div ref={modelRef} className="dso-pick">
        <span className="dso-pick-label">模型</span>
        <button
          type="button"
          className={`dso-pick-btn${open === "model" ? " open" : ""}`}
          disabled={busy}
          onClick={() => setOpen(open === "model" ? null : "model")}
          title={unknown ? undefined : `${provider} / ${model}`}
        >
          <span className="dso-ellipsis">{unknown ? "未知" : model}</span>
          {!unknown && <small>{provider}</small>}
          <span className="dso-caret">▾</span>
        </button>
        {open === "model" && (
          <div className="dso-pick-menu dso-model-menu">
            <input
              className="dso-model-search"
              placeholder="搜索模型…"
              value={query}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(null);
              }}
            />
            {groups === null ? (
              <div className="dso-empty">加载中…</div>
            ) : shown.length === 0 ? (
              <div className="dso-empty">没有匹配的模型</div>
            ) : (
              shown.map((group) => (
                <div key={group.provider}>
                  <div className="dso-model-group">{group.name}</div>
                  {group.error !== undefined && group.models.length === 0 && (
                    <div className="dso-empty" title={group.error}>
                      ⚠ 读取失败
                    </div>
                  )}
                  {group.models.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={group.provider === provider && m.id === model ? "on" : ""}
                      title={`${group.provider} / ${m.id}`}
                      onClick={() => void apply({ provider: group.provider, model: m.id })}
                    >
                      <span className="dso-ellipsis">{m.name}</span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        )}
      </div>
      {!unknown && efforts !== null && efforts.list.length > 0 && (
        <div ref={effortRef} className="dso-pick">
          <span className="dso-pick-label">推理</span>
          <button
            type="button"
            className={`dso-pick-btn${open === "effort" ? " open" : ""}`}
            disabled={busy}
            onClick={() => setOpen(open === "effort" ? null : "effort")}
          >
            <span>{effortName(member.reasoningEffort ?? efforts.fallback) ?? "默认"}</span>
            {member.reasoningEffort === undefined && <small>默认</small>}
            <span className="dso-caret">▾</span>
          </button>
          {open === "effort" && (
            <div className="dso-pick-menu">
              <button
                type="button"
                className={member.reasoningEffort === undefined ? "on" : ""}
                onClick={() => void apply({ provider: provider!, model: model! })}
              >
                默认{efforts.fallback ? `（${effortName(efforts.fallback)}）` : ""}
              </button>
              {efforts.list.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={member.reasoningEffort === e.id ? "on" : ""}
                  onClick={() => void apply({ provider: provider!, model: model!, reasoningEffort: e.id })}
                >
                  {e.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {busy && <div className="dso-muted">切换中…</div>}
      {failure && <div className="dso-error">{failure}</div>}
    </>
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
  onModelChanged,
}: {
  api: SceneModule | null;
  member: OfficeMember;
  running: boolean;
  snapshot: OfficeSnapshot;
  onBack: () => void;
  onFocus: () => void;
  onOpen: () => void;
  onOverride: (patch: OverridePatch) => Promise<void>;
  onModelChanged: () => void;
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
          ◎ 在场景中定位
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
        <span>模型</span>
        <small>下一步生效</small>
      </h3>
      <div className="dso-picks">
        <ModelPicks member={member} onChanged={onModelChanged} />
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
