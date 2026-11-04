/**
 * 办公室模式的状态：是否开启、正在看的团队持久化在 localStorage，刷新后直接回到办公室；
 * 「对话展开」只在内存里（刷新后回到 3D 办公室）。
 */

import { useSyncExternalStore } from "react";

export interface OfficeState {
  readonly on: boolean;
  readonly lead: string | null;
  /** 原生对话是否展开（展开时收起 3D 场景，只留左侧成员栏）。 */
  readonly chatOpen: boolean;
}

const KEY = "dsh-config:office";
const DEFAULT: OfficeState = { on: false, lead: null, chatOpen: false };

function read(): OfficeState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULT;
    const v = JSON.parse(raw) as Partial<OfficeState>;
    return {
      on: v.on === true,
      lead: typeof v.lead === "string" ? v.lead : null,
      chatOpen: false,
    };
  } catch {
    return DEFAULT;
  }
}

let state = read();
const listeners = new Set<() => void>();

export function getOffice(): OfficeState {
  return state;
}

export function setOffice(patch: Partial<OfficeState>): void {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify({ on: state.on, lead: state.lead }));
  } catch {
    // 隐私模式等：只在内存里记
  }
  for (const listener of listeners) listener();
}

export function useOffice(): OfficeState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getOffice,
    getOffice,
  );
}

/**
 * 原生界面当前选中的会话（工作区把选择持久化在 `dsh.sessions.current`）。
 * 子会话返回其父会话（组长）作为团队候选，同时返回自身。
 */
export function currentSession(): { sessionId?: string; parentSessionId?: string } {
  try {
    const raw = localStorage.getItem("dsh.sessions.current");
    if (raw === null) return {};
    const found: { sessionId?: string; parentSessionId?: string } = {};
    const walk = (value: unknown, depth: number) => {
      if (depth > 4 || typeof value !== "object" || value === null) return;
      const record = value as Record<string, unknown>;
      if (found.sessionId === undefined && typeof record.sessionId === "string") found.sessionId = record.sessionId;
      if (found.parentSessionId === undefined && typeof record.parentSessionId === "string")
        found.parentSessionId = record.parentSessionId;
      for (const child of Object.values(record)) walk(child, depth + 1);
    };
    walk(JSON.parse(raw), 0);
    return found;
  } catch {
    return {};
  }
}
