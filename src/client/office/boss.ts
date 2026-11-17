/**
 * 老板办公室：所有团队的组长在「汇报完毕 / 出错停下 / 派完活等组员」时来这里向你汇报；
 * 单智能体（共享办公室的入选者）这一轮结束时也来（汇报 / 出错，没有「等组员」）。
 * 汇报 / 出错打开对话或点「知道了」后算看过，离开老板办公室（与醒目提醒共用 `dsh-config:office-ack`）。
 *
 * - 候选（浏览器端，零扫描）：组建过团队的会话（/office/teams）与会话列表里有子会话的顶层会话，
 *   只留 24 小时内组长或任一组员有活动（或正在运行）的；最近活跃的在前，最多 {@link BOSS_CAP} 个。
 * - 事实：`GET /dsh-config/office/leads?ids=…` 只为候选读组长与组员摘要（宿主按存储版本缓存），带 ETag；
 *   在老板办公室里每 5 秒轮询，其他时候每 15 秒（只为 HUD 角标）。
 * - 判定（`office/boss.ts`）：是否在跑以浏览器会话状态为准，宿主推导兜底。
 */

import { useEffect, useMemo, useState } from "react";
import { bossStateOf, type BossState } from "../../office/boss.ts";
import type { OfficeMember, OfficeSnapshot, OfficeWorking } from "../../office/types.ts";
import type { Crew, SoloProject } from "./projects.ts";
import { SOLO_WINDOW_MS, rootOf, type SessionListLike } from "./shared.ts";

export const BOSS_CAP = 24;

/** 宿主 /office/leads 的一项。 */
export interface LeadFacts {
  readonly member: OfficeMember;
  readonly leadWaiting: boolean;
  readonly memberIds: readonly string[];
  readonly membersRunning: boolean;
}

function ms(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return value < 1e12 ? value * 1000 : value;
}

/**
 * 挑出 24 小时内有活动的团队的组长（纯函数）：团队以 /office/teams 的名册为准；活动看组长整棵
 * 子代理树（组员、组员派的子代理……）里最近的一次，正在运行的算「此刻」。
 */
export function pickLeads(state: SessionListLike | undefined, teamLeads: ReadonlySet<string>, now: number): string[] {
  const byId = state?.byId ?? {};
  const activity = new Map<string, number>();
  const score = (row: { running?: boolean; updatedAt?: number } | undefined) =>
    row === undefined ? 0 : row.running === true ? now : ms(row.updatedAt);
  for (const id of teamLeads) activity.set(id, score(byId[id]));
  for (const [id, row] of Object.entries(byId)) {
    const root = rootOf(byId, id);
    if (root === id || !activity.has(root)) continue;
    activity.set(root, Math.max(activity.get(root)!, score(row)));
  }
  return [...activity]
    .filter(([, at]) => now - at <= SOLO_WINDOW_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, BOSS_CAP)
    .map(([id]) => id);
}

type UseSessions = (selector: (state: SessionListLike | undefined) => string) => string;

export function useLeadPick(useSessions: UseSessions | undefined, teamLeads: ReadonlySet<string>): string[] {
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    const timer = setInterval(() => setMinute(Math.floor(Date.now() / 60_000)), 60_000);
    return () => clearInterval(timer);
  }, []);
  const leadKey = [...teamLeads].sort().join(",");
  const key = useSessions?.((state) => pickLeads(state, teamLeads, minute * 60_000).join(",")) ?? leadKey;
  return useMemo(() => (key === "" ? [] : key.split(",")), [key]);
}

export function useLeadFacts(ids: readonly string[], active: boolean): { leads: LeadFacts[] | null; error: string | null } {
  const [leads, setLeads] = useState<LeadFacts[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idKey = ids.join(",");
  useEffect(() => {
    if (idKey === "") {
      setLeads([]);
      return;
    }
    let stopped = false;
    let etag = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/dsh-config/office/leads?ids=${encodeURIComponent(idKey)}`, {
          headers: { "x-dsh-config": "agent-office", ...(etag ? { "if-none-match": etag } : {}) },
          cache: "no-store",
        });
        if (response.status === 200) {
          etag = response.headers.get("etag") ?? "";
          const body = (await response.json()) as { leads?: LeadFacts[] };
          if (!stopped) {
            setLeads(body.leads ?? []);
            setError(null);
          }
        } else if (response.status !== 304) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          if (!stopped) setError(body.error ?? `HTTP ${response.status}`);
        }
      } catch (reason) {
        if (!stopped) setError(String(reason));
      }
      const wait = (active ? 5000 : 15000) * (document.hidden ? 3 : 1);
      if (!stopped) timer = setTimeout(poll, wait);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [idKey, active]);
  return { leads, error };
}

/**
 * 组长 → 老板办公室状态（在跑以浏览器会话状态为准）。
 * @param live - 会话 id → 是否在跑（浏览器）；缺省的用宿主推导。
 */
export function bossOf(facts: LeadFacts, live: Readonly<Record<string, boolean>>): BossState | null {
  const leadRunning = live[facts.member.id] ?? facts.member.busy;
  const known = facts.memberIds.filter((id) => live[id] !== undefined);
  const membersRunning = known.length > 0 ? known.some((id) => live[id] === true) : facts.membersRunning;
  return bossStateOf({ leadRunning, leadWaiting: facts.leadWaiting, lastTurn: facts.member.lastTurn, membersRunning });
}

/** 单智能体 → 老板办公室状态：这一轮结束且自己没在跑才来，没有「等组员」。 */
export function soloBossOf(member: OfficeMember, live: Readonly<Record<string, boolean>>): BossState | null {
  const running = live[member.id] ?? member.busy;
  return bossStateOf({ leadRunning: running, leadWaiting: false, lastTurn: member.lastTurn, membersRunning: false });
}

/**
 * 老板办公室的快照：有事的组长与单智能体。待处理（汇报 / 出错）在前，按等得最久的先排（先来先办）；
 * 等组员的在后。看过的汇报（ack ≥ 这一轮结束时间）不再出现。
 * @param solos - 单智能体（共享办公室入选者的详情，已带项目名）；null = 还没取到。
 * @param acks - 会话 id → 已看过的那一轮结束时间。
 */
export function bossSnapshot(
  leads: readonly LeadFacts[] | null,
  live: Readonly<Record<string, boolean>>,
  nameOf: (cwd: string | undefined) => string,
  solos: readonly OfficeMember[] | null = [],
  acks: Readonly<Record<string, number>> = {},
): OfficeSnapshot | null {
  if (leads === null) return null;
  const seen = (m: OfficeMember, state: BossState) =>
    state !== "waiting" && m.lastTurn !== undefined && (acks[m.id] ?? 0) >= m.lastTurn.at;
  const fromLeads = leads.flatMap((facts): OfficeMember[] => {
    const state = bossOf(facts, live);
    if (state === null || seen(facts.member, state)) return [];
    return [{ ...facts.member, project: nameOf(facts.member.cwd), boss: state }];
  });
  const leadIds = new Set(leads.map((f) => f.member.id));
  const fromSolos = (solos ?? []).flatMap((m): OfficeMember[] => {
    if (leadIds.has(m.id)) return [];
    const state = soloBossOf(m, live);
    if (state === null || seen(m, state)) return [];
    return [{ ...m, project: m.project ?? nameOf(m.cwd), boss: state }];
  });
  const members = [...fromLeads, ...fromSolos].sort((a, b) => {
    const wa = a.boss === "waiting";
    const wb = b.boss === "waiting";
    if (wa !== wb) return Number(wa) - Number(wb);
    return (a.lastTurn?.at ?? 0) - (b.lastTurn?.at ?? 0);
  });
  return {
    leadId: "",
    projectName: "老板办公室",
    generatedAt: Date.now(),
    members,
    interactions: [],
    tasks: [],
    taskSource: "none",
  };
}

/** 左栏 / 墙屏上的一个「正在干活」项目。 */
export interface WorkingProject extends OfficeWorking {
  /** 团队：组长 id；单智能体项目：文件夹。 */
  readonly key: string;
}

/**
 * 正在干活、没在老板办公室里的项目（纯函数，忙闲口径与项目总览一致：整棵子代理树）：
 * 有人在跑的团队（组长已在屋里汇报 / 等组员的不重复列）与有人在跑的单智能体项目；在跑多的在前。
 */
export function workingProjects(
  teams: readonly { leadId: string; cwd?: string | undefined }[],
  crews: Readonly<Record<string, Crew>>,
  soloProjects: readonly SoloProject[],
  inRoom: ReadonlySet<string>,
  nameOf: (cwd: string | undefined) => string,
): WorkingProject[] {
  const out: WorkingProject[] = [];
  for (const team of teams) {
    const crew = crews[team.leadId];
    if (crew === undefined || crew.running === 0 || inRoom.has(team.leadId)) continue;
    out.push({ key: team.leadId, kind: "team", name: nameOf(team.cwd), running: crew.running, total: crew.total });
  }
  for (const project of soloProjects) {
    if (project.running === 0) continue;
    out.push({ key: project.cwd, kind: "solo", name: nameOf(project.cwd || undefined), running: project.running, total: project.total });
  }
  return out.sort((a, b) => b.running - a.running || a.name.localeCompare(b.name, "zh"));
}
