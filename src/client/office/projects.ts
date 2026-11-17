/**
 * 项目忙闲总览（项目切换器用）：哪些项目正在干活。全部在浏览器端从原生会话列表算，零扫描。
 *
 * - 团队：组长与它的子会话里有几个在跑。
 * - 单智能体项目：共享办公室的入选者（同一套 24 小时活跃筛选）按文件夹分组，几个在跑 / 共几个。
 */

import { useMemo } from "react";
import type { SessionListLike, SessionRowLike } from "./shared.ts";

interface RowWithCwd extends SessionRowLike {
  readonly cwd?: string;
}

export interface SoloProject {
  readonly cwd: string;
  /** 入选的单智能体会话（按共享办公室的顺序：在跑的在前）。 */
  readonly ids: readonly string[];
  readonly running: number;
}

export interface ProjectActivity {
  /** 组长 id → 团队里在跑的会话数（组长 + 组员）。 */
  readonly teamRunning: Readonly<Record<string, number>>;
  /** 单智能体项目：在跑的在前，其次人多的在前。 */
  readonly soloProjects: readonly SoloProject[];
}

/** 纯函数：从会话列表算项目忙闲。 */
export function projectActivity(
  state: SessionListLike | undefined,
  teamLeads: readonly string[],
  soloIds: readonly string[],
): ProjectActivity {
  const byId = (state?.byId ?? {}) as Readonly<Record<string, RowWithCwd | undefined>>;
  const teamRunning: Record<string, number> = {};
  for (const lead of teamLeads) teamRunning[lead] = byId[lead]?.running === true ? 1 : 0;
  for (const row of Object.values(byId)) {
    const parent = row?.parentSessionId;
    if (parent !== undefined && parent in teamRunning && row?.running === true) teamRunning[parent] = teamRunning[parent]! + 1;
  }
  const groups = new Map<string, { ids: string[]; running: number }>();
  for (const id of soloIds) {
    const row = byId[id];
    const cwd = row?.cwd ?? "";
    const group = groups.get(cwd) ?? { ids: [], running: 0 };
    group.ids.push(id);
    if (row?.running === true) group.running += 1;
    groups.set(cwd, group);
  }
  const soloProjects = [...groups]
    .map(([cwd, g]) => ({ cwd, ids: g.ids, running: g.running }))
    .sort((a, b) => Number(b.running > 0) - Number(a.running > 0) || b.ids.length - a.ids.length || a.cwd.localeCompare(b.cwd));
  return { teamRunning, soloProjects };
}

type UseSessions = (selector: (state: SessionListLike | undefined) => string) => string;

/** 订阅会话列表：选择器只返回结果的 JSON，会话列表其他变化不触发重渲染。 */
export function useProjectActivity(
  useSessions: UseSessions | undefined,
  teamLeads: readonly string[],
  soloIds: readonly string[],
): ProjectActivity {
  const key =
    useSessions?.((state) => JSON.stringify(projectActivity(state, teamLeads, soloIds))) ??
    JSON.stringify(projectActivity(undefined, teamLeads, soloIds));
  return useMemo(() => JSON.parse(key) as ProjectActivity, [key]);
}
