/**
 * 办公室模式的持久状态（localStorage）：是否开启、正在看的团队、右侧原生对话栏宽度。
 * 刷新后按记录直接回到办公室。
 */

import { useSyncExternalStore } from "react";

export interface OfficeState {
  readonly on: boolean;
  readonly lead: string | null;
  readonly chat: number;
}

const KEY = "dsh-config:office";
const DEFAULT: OfficeState = { on: false, lead: null, chat: 480 };
export const CHAT_MIN = 360;
export const CHAT_MAX = 960;

function read(): OfficeState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULT;
    const v = JSON.parse(raw) as Partial<OfficeState>;
    return {
      on: v.on === true,
      lead: typeof v.lead === "string" ? v.lead : null,
      chat: typeof v.chat === "number" ? Math.min(CHAT_MAX, Math.max(CHAT_MIN, v.chat)) : DEFAULT.chat,
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
    localStorage.setItem(KEY, JSON.stringify(state));
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
