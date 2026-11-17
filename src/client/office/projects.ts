/**
 * 项目忙闲（浏览器端，从原生会话列表算，零扫描）。
 *
 * 概念模型：可视化的单位只有组长、组员（在组长 `team/member` 名册里）、单智能体（顶层独立会话）。
 * 子代理 = 不在名册里的 subagent 会话（组长、组员、单智能体用工具临时派的），不单独出现——
 * 不占格子、不入座、不去老板办公室；它在跑，就算派它的那个单位在跑（沿子代理链往上找最近的单位）。
 */

import { useMemo } from "react";
import type { SessionListLike, SessionRowLike } from "./shared.ts";

/** 一组单位的人手：几个、几个在跑；团队另记组长是否在跑（组长单位排第一个）。 */
export interface Crew {
  readonly total: number;
  readonly running: number;
  readonly leadOn?: boolean | undefined;
}

export interface SoloProject extends Crew {
  readonly cwd: string;
  /** 入选的单智能体会话（按共享办公室的顺序：在跑的在前）。 */
  readonly ids: readonly string[];
}

export interface ProjectActivity {
  /** 组长 id → 团队（组长 + 名册组员）。 */
  readonly teams: Readonly<Record<string, Crew>>;
  /** 单智能体项目：在跑的在前，其次人多的在前。 */
  readonly soloProjects: readonly SoloProject[];
  /** 共享办公室合计。 */
  readonly shared: Crew;
}

export interface TeamRoster {
  readonly leadId: string;
  readonly memberIds?: readonly string[] | undefined;
}

/**
 * 会话归属的单位：自己是单位就是自己；否则沿子代理链（`origin === "subagent"`）往上，
 * 第一个是单位的祖先；链断了（父会话不在列表里）就停在链顶。
 */
export function unitOf(byId: Readonly<Record<string, SessionRowLike | undefined>>, id: string, units: ReadonlySet<string>): string {
  let current = id;
  for (let depth = 0; depth < 32; depth += 1) {
    if (units.has(current)) return current;
    const row = byId[current];
    const parent = row?.parentSessionId;
    if (row?.origin !== "subagent" || parent === undefined || byId[parent] === undefined) return current;
    current = parent;
  }
  return current;
}

/** 在跑的单位：自己在跑，或它的任意层级子代理在跑。 */
export function busyUnits(state: SessionListLike | undefined, units: ReadonlySet<string>): Set<string> {
  const byId = state?.byId ?? {};
  const busy = new Set<string>();
  for (const [id, row] of Object.entries(byId)) {
    if (row?.running !== true) continue;
    const unit = unitOf(byId, id, units);
    if (units.has(unit)) busy.add(unit);
  }
  return busy;
}

/** 所有单位：各团队的组长与名册组员、单智能体。 */
export function unitSet(teams: readonly TeamRoster[], soloIds: readonly string[]): Set<string> {
  const units = new Set<string>(soloIds);
  for (const team of teams) {
    units.add(team.leadId);
    for (const id of team.memberIds ?? []) units.add(id);
  }
  return units;
}

/** 纯函数：从会话列表算项目忙闲。 */
export function projectActivity(
  state: SessionListLike | undefined,
  teams: readonly TeamRoster[],
  soloIds: readonly string[],
): ProjectActivity {
  const byId = (state?.byId ?? {}) as Readonly<Record<string, (SessionRowLike & { cwd?: string }) | undefined>>;
  const busy = busyUnits(state, unitSet(teams, soloIds));
  const out: Record<string, Crew> = {};
  for (const team of teams) {
    const members = team.memberIds ?? [];
    const leadOn = busy.has(team.leadId);
    out[team.leadId] = { total: 1 + members.length, running: Number(leadOn) + members.filter((id) => busy.has(id)).length, leadOn };
  }
  const groups = new Map<string, { ids: string[]; running: number }>();
  for (const id of soloIds) {
    const cwd = byId[id]?.cwd ?? "";
    const group = groups.get(cwd) ?? { ids: [], running: 0 };
    group.ids.push(id);
    if (busy.has(id)) group.running += 1;
    groups.set(cwd, group);
  }
  const soloProjects = [...groups]
    .map(([cwd, g]) => ({ cwd, ids: g.ids, total: g.ids.length, running: g.running }))
    .sort((a, b) => Number(b.running > 0) - Number(a.running > 0) || b.total - a.total || a.cwd.localeCompare(b.cwd));
  const shared = soloProjects.reduce((sum, p) => ({ total: sum.total + p.total, running: sum.running + p.running }), {
    total: 0,
    running: 0,
  });
  return { teams: out, soloProjects, shared };
}

type UseSessions = (selector: (state: SessionListLike | undefined) => string) => string;

/** 订阅会话列表：选择器只返回结果 JSON，会话列表其他变化不触发重渲染。 */
export function useProjectActivity(
  useSessions: UseSessions | undefined,
  teams: readonly TeamRoster[],
  soloIds: readonly string[],
): ProjectActivity {
  const key =
    useSessions?.((state) => JSON.stringify(projectActivity(state, teams, soloIds))) ??
    JSON.stringify(projectActivity(undefined, teams, soloIds));
  return useMemo(() => JSON.parse(key) as ProjectActivity, [key]);
}

/** 这些单位里哪些因子代理（或自己）在跑而算在跑——并进场景、老板办公室的在跑判定。 */
export function useBusyUnits(useSessions: UseSessions | undefined, units: ReadonlySet<string>): ReadonlySet<string> {
  const key = useSessions?.((state) => [...busyUnits(state, units)].sort().join(",")) ?? "";
  return useMemo(() => new Set(key === "" ? [] : key.split(",")), [key]);
}
