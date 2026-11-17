/**
 * 项目忙闲总览（项目切换器用）：哪些项目正在干活。全部在浏览器端从原生会话列表算，零扫描。
 *
 * 子代理：原生会话列表含任意层级的子代理会话（`origin === "subagent"`、`parentSessionId` 指向派它的会话；
 * 团队组员是组长的子代理，组员 / 单智能体自己派的子代理挂在它们下面）。普通分叉也可能带 parentSessionId，
 * 但不是子代理，是独立会话。这里沿子代理链把每个会话归到它的顶层会话：
 *
 * - 团队：组长及其整棵子代理树（组员、组员派的子代理……）。
 * - 单智能体项目：共享办公室的入选者（顶层会话）按文件夹分组，各自连同它们派的子代理。
 *
 * 一个项目的「人」= 顶层会话 + 24 小时内活跃（或正在运行）的子孙；「在跑」= 其中正在运行的。
 */

import { useMemo } from "react";
import { SOLO_WINDOW_MS, rootOf, type SessionListLike, type SessionRowLike } from "./shared.ts";

export { rootOf };

interface RowWithCwd extends SessionRowLike {
  readonly cwd?: string;
}

/** 一个项目里的智能体：几个人、几个在跑。 */
export interface Crew {
  readonly total: number;
  readonly running: number;
}

export interface SoloProject extends Crew {
  readonly cwd: string;
  /** 入选的单智能体会话（按共享办公室的顺序：在跑的在前）。 */
  readonly ids: readonly string[];
}

export interface ProjectActivity {
  /** 组长 id → 团队（组长 + 整棵子代理树）。 */
  readonly teams: Readonly<Record<string, Crew>>;
  /** 单智能体项目：在跑的在前，其次人多的在前。 */
  readonly soloProjects: readonly SoloProject[];
  /** 共享办公室合计。 */
  readonly shared: Crew;
}

function ms(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return value < 1e12 ? value * 1000 : value;
}

/** 每个顶层会话的人手（顶层会话本身 + 24 小时内活跃或在跑的子孙）。 */
export function crews(state: SessionListLike | undefined, now: number): Map<string, { total: number; running: number }> {
  const byId = state?.byId ?? {};
  const out = new Map<string, { total: number; running: number }>();
  for (const [id, row] of Object.entries(byId)) {
    if (row === undefined) continue;
    const root = rootOf(byId, id);
    const running = row.running === true;
    if (root !== id && !running && now - ms(row.updatedAt) > SOLO_WINDOW_MS) continue;
    const crew = out.get(root) ?? { total: 0, running: 0 };
    crew.total += 1;
    if (running) crew.running += 1;
    out.set(root, crew);
  }
  return out;
}

/** 纯函数：从会话列表算项目忙闲。 */
export function projectActivity(
  state: SessionListLike | undefined,
  teamLeads: readonly string[],
  soloIds: readonly string[],
  now: number,
): ProjectActivity {
  const byId = (state?.byId ?? {}) as Readonly<Record<string, RowWithCwd | undefined>>;
  const all = crews(state, now);
  const crewOf = (id: string): Crew => all.get(id) ?? { total: 1, running: 0 };
  const teams: Record<string, Crew> = {};
  for (const lead of teamLeads) teams[lead] = crewOf(lead);
  const groups = new Map<string, { ids: string[]; total: number; running: number }>();
  for (const id of soloIds) {
    const cwd = byId[id]?.cwd ?? "";
    const group = groups.get(cwd) ?? { ids: [], total: 0, running: 0 };
    const crew = crewOf(id);
    group.ids.push(id);
    group.total += crew.total;
    group.running += crew.running;
    groups.set(cwd, group);
  }
  const soloProjects = [...groups]
    .map(([cwd, g]) => ({ cwd, ids: g.ids, total: g.total, running: g.running }))
    .sort((a, b) => Number(b.running > 0) - Number(a.running > 0) || b.total - a.total || a.cwd.localeCompare(b.cwd));
  const shared = soloProjects.reduce((sum, p) => ({ total: sum.total + p.total, running: sum.running + p.running }), {
    total: 0,
    running: 0,
  });
  return { teams, soloProjects, shared };
}

type UseSessions = (selector: (state: SessionListLike | undefined) => string) => string;

/** 订阅会话列表：选择器只返回结果的 JSON，会话列表其他变化不触发重渲染（「24 小时」按分钟取整）。 */
export function useProjectActivity(
  useSessions: UseSessions | undefined,
  teamLeads: readonly string[],
  soloIds: readonly string[],
): ProjectActivity {
  const now = () => Math.floor(Date.now() / 60_000) * 60_000;
  const key =
    useSessions?.((state) => JSON.stringify(projectActivity(state, teamLeads, soloIds, now()))) ??
    JSON.stringify(projectActivity(undefined, teamLeads, soloIds, now()));
  return useMemo(() => JSON.parse(key) as ProjectActivity, [key]);
}
