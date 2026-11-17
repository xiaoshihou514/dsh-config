/**
 * 共享办公室：所有项目的单智能体（非团队会话）坐一个大办公室。
 *
 * - 入选（浏览器端，零扫描）：原生会话列表里的顶层会话（不是任何会话派出的子代理）、非空白、
 *   不是组长（不在 /office/teams 团队列表里），并且正在运行或 24 小时内有活动。派过子代理的单智能体
 *   照样入选——子代理本身不入选，但算进它所属项目的忙闲（见 projects.ts）。
 *   在跑的优先，其次按最近活动；最多 {@link SOLO_CAP} 人，多出的只在 HUD 提示人数。
 * - 详情：`GET /dsh-config/office/solo?ids=…` 只为入选者补模型、当前动作、最近一轮（宿主按存储版本缓存摘要），
 *   带 ETag 轮询：在共享办公室里每 3 秒，其他时候每 15 秒（老板办公室的单智能体汇报与 HUD 角标要用）。
 */

import { useEffect, useMemo, useState } from "react";
import type { OfficeMember, OfficeSnapshot } from "../../office/types.ts";

/** 共享办公室座位数（与场景排式布局一致）。 */
export const SOLO_CAP = 24;
/** 「最近活跃」窗口。 */
export const SOLO_WINDOW_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 3000;

/** 原生会话列表里用到的字段（宽松：宿主结构变化时只是选不出人）。 */
export interface SessionRowLike {
  readonly running?: boolean;
  readonly blank?: boolean;
  readonly parentSessionId?: string;
  readonly origin?: string;
  readonly updatedAt?: number;
}
export interface SessionListLike {
  readonly ids?: readonly string[];
  readonly byId?: Readonly<Record<string, SessionRowLike | undefined>>;
}

/**
 * 子代理链上的顶层会话：只沿 `origin === "subagent"` 往上走（普通分叉也可能带 parentSessionId，
 * 但它是独立会话）；父会话不在列表里时停在自己。
 */
export function rootOf(byId: Readonly<Record<string, SessionRowLike | undefined>>, id: string): string {
  let current = id;
  for (let depth = 0; depth < 32; depth += 1) {
    const row = byId[current];
    const parent = row?.parentSessionId;
    if (row?.origin !== "subagent" || parent === undefined || byId[parent] === undefined) return current;
    current = parent;
  }
  return current;
}

/** 宿主的时间可能是秒或毫秒：统一成毫秒。 */
function ms(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return value < 1e12 ? value * 1000 : value;
}

/**
 * 从会话列表选出共享办公室的人（纯函数）。
 * @param leads - 组建过团队的会话（组长，以 /office/teams 的名册为准）。
 * @returns 入选 id（在跑的在前，其次最近活跃的在前）与未显示的人数。
 */
export function pickSolo(
  state: SessionListLike | undefined,
  leads: ReadonlySet<string>,
  now: number,
): { ids: string[]; overflow: number } {
  const byId = state?.byId ?? {};
  const ids = state?.ids ?? Object.keys(byId);
  const picked: { id: string; running: boolean; at: number }[] = [];
  for (const id of ids) {
    const row = byId[id];
    if (row === undefined || row.blank === true) continue;
    // 子代理（任意层级）不单独入选——父会话不在列表里（已归档、只保留了子会话）时链会断，
    // 所以凡是 origin 为 subagent 的一律排除；组长（组建过团队）不入选
    if (row.origin === "subagent" || rootOf(byId, id) !== id || leads.has(id)) continue;
    const running = row.running === true;
    const at = ms(row.updatedAt);
    if (!running && now - at > SOLO_WINDOW_MS) continue;
    picked.push({ id, running, at });
  }
  picked.sort((a, b) => Number(b.running) - Number(a.running) || b.at - a.at);
  return { ids: picked.slice(0, SOLO_CAP).map((p) => p.id), overflow: Math.max(0, picked.length - SOLO_CAP) };
}

type UseSessions = (selector: (state: SessionListLike | undefined) => string) => string;

/**
 * 入选者（只在共享办公室视图时计算）。选择器返回字符串，会话列表其他变化不触发重渲染；
 * 「24 小时」边界每分钟重算一次。
 */
export function useSoloPick(
  enabled: boolean,
  useSessions: UseSessions | undefined,
  leads: ReadonlySet<string>,
): { ids: string[]; overflow: number } {
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setMinute(Math.floor(Date.now() / 60_000)), 60_000);
    return () => clearInterval(timer);
  }, [enabled]);
  const leadKey = [...leads].sort().join(",");
  const key =
    useSessions?.((state) => {
      if (!enabled) return "";
      const { ids, overflow } = pickSolo(state, leads, minute * 60_000);
      return `${ids.join(",")}|${overflow}`;
    }) ?? "";
  return useMemo(() => {
    const [list = "", overflow = "0"] = key.split("|");
    return { ids: list === "" ? [] : list.split(","), overflow: Number(overflow) || 0 };
    // leadKey 参与依赖：团队列表变了要重选
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, leadKey]);
}

/**
 * 共享办公室的快照：入选者的详情（模型、当前动作、最近一轮），按项目排好座次（同项目坐在一起）。
 * @param enabled - 是否轮询。
 * @param active - 正在看共享办公室：轮询更勤。
 * @param nameOf - 文件夹 → 项目显示名。
 */
export function useSoloSnapshot(
  enabled: boolean,
  ids: readonly string[],
  nameOf: (cwd: string | undefined) => string,
  active = true,
): { snapshot: OfficeSnapshot | null; error: string | null } {
  const [members, setMembers] = useState<OfficeMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idKey = ids.join(",");
  useEffect(() => {
    if (!enabled) return;
    if (idKey === "") {
      setMembers([]);
      return;
    }
    let stopped = false;
    let etag = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/dsh-config/office/solo?ids=${encodeURIComponent(idKey)}`, {
          headers: { "x-dsh-config": "agent-office", ...(etag ? { "if-none-match": etag } : {}) },
          cache: "no-store",
        });
        if (response.status === 200) {
          etag = response.headers.get("etag") ?? "";
          const body = (await response.json()) as { members?: OfficeMember[] };
          if (!stopped) {
            setMembers(body.members ?? []);
            setError(null);
          }
        } else if (response.status !== 304) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          if (!stopped) setError(body.error ?? `HTTP ${response.status}`);
        }
      } catch (reason) {
        if (!stopped) setError(String(reason));
      }
      const wait = (active ? POLL_MS : POLL_MS * 5) * (document.hidden ? 4 : 1);
      if (!stopped) timer = setTimeout(poll, wait);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [enabled, idKey, active]);
  const snapshot = useMemo((): OfficeSnapshot | null => {
    if (!enabled || members === null) return null;
    const order = new Map(ids.map((id, i) => [id, i]));
    const seated = members
      .filter((m) => order.has(m.id))
      .map((m) => ({ ...m, project: nameOf(m.cwd) }))
      .sort((a, b) => a.project.localeCompare(b.project, "zh") || order.get(a.id)! - order.get(b.id)!);
    return {
      leadId: "",
      projectName: "共享办公室",
      generatedAt: Date.now(),
      members: seated,
      interactions: [],
      tasks: [],
      taskSource: "none",
    };
    // nameOf 每次渲染是新函数：按项目名变化由成员 / ids 触发即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, members, idKey]);
  return { snapshot, error };
}
