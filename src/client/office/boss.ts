/**
 * 老板办公室：所有团队的组长在「汇报完毕 / 出错停下 / 派完活等组员」时来这里向你汇报。
 *
 * - 候选（浏览器端，零扫描）：组建过团队的会话（/office/teams）与会话列表里有子会话的顶层会话，
 *   只留 24 小时内组长或任一组员有活动（或正在运行）的；最近活跃的在前，最多 {@link BOSS_CAP} 个。
 * - 事实：`GET /dsh-config/office/leads?ids=…` 只为候选读组长与组员摘要（宿主按存储版本缓存），带 ETag；
 *   在老板办公室里每 5 秒轮询，其他时候每 15 秒（只为 HUD 角标）。
 * - 判定（`office/boss.ts`）：是否在跑以浏览器会话状态为准，宿主推导兜底。
 */

import { useEffect, useMemo, useState } from "react";
import { bossStateOf, type BossState } from "../../office/boss.ts";
import type { OfficeMember, OfficeSnapshot } from "../../office/types.ts";
import { SOLO_WINDOW_MS, type SessionListLike } from "./shared.ts";

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
 * 挑出 24 小时内有活动的团队的组长（纯函数）。
 * @param teamLeads - 组建过团队的会话（还没招人的组长没有子会话，靠它补上）。
 */
export function pickLeads(state: SessionListLike | undefined, teamLeads: ReadonlySet<string>, now: number): string[] {
  const byId = state?.byId ?? {};
  const activity = new Map<string, number>();
  const bump = (id: string, at: number) => activity.set(id, Math.max(activity.get(id) ?? 0, at));
  const score = (row: { running?: boolean; updatedAt?: number } | undefined) =>
    row === undefined ? 0 : row.running === true ? now : ms(row.updatedAt);
  for (const id of teamLeads) bump(id, score(byId[id]));
  for (const [id, row] of Object.entries(byId)) {
    if (row?.parentSessionId === undefined) continue;
    const parent = row.parentSessionId;
    // 子会话的父会话是组长（多级子会话只认顶层父）
    if (byId[parent]?.parentSessionId !== undefined) continue;
    bump(parent, Math.max(score(byId[parent]), score(row)));
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

/** 老板办公室的快照：只放有事的组长（汇报 / 出错在前）。 */
export function bossSnapshot(
  leads: readonly LeadFacts[] | null,
  live: Readonly<Record<string, boolean>>,
  nameOf: (cwd: string | undefined) => string,
): OfficeSnapshot | null {
  if (leads === null) return null;
  const members = leads
    .map((facts) => ({ facts, state: bossOf(facts, live) }))
    .filter((x): x is { facts: LeadFacts; state: BossState } => x.state !== null)
    .sort((a, b) => Number(a.state === "waiting") - Number(b.state === "waiting"))
    .map(({ facts, state }): OfficeMember => ({ ...facts.member, project: nameOf(facts.member.cwd), boss: state }));
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
