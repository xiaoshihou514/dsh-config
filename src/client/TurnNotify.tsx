/**
 * 回合完成系统通知：会话从运行中转为空闲、且没有排队消息立即开启新轮时，
 * 发浏览器系统通知提醒（仅页面不可见时；可见时不打扰）。通知里带会话标题。
 * 注册在 conversation.input.left 槽位以获取 session 标准注入面，自身不渲染。
 */

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

interface SessionLike {
  running?: boolean;
  pendingSubmissions?: readonly unknown[];
  lastAgentError?: string | null;
}

type UseSessionHook = (selector: (snapshot: unknown) => unknown) => unknown;
type UseProjectionHook = (key: "title") => string | null | undefined;

const NOTIFY_DELAY_MS = 1_500;

function ensurePermission(): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default")
    void Notification.requestPermission().catch(() => {});
}

function fire(snapshot: SessionLike | undefined, title: string | null): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  const label = title ? `「${title}」` : "";
  const error = snapshot?.lastAgentError ?? null;
  const notification = new Notification(
    error ? `${label}任务运行失败` : `${label}任务已完成`,
    {
      body: error ?? "会话已空闲，没有排队消息，可以回来查看了。",
      tag: "dsh-config-turn-notify",
    },
  );
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}

export function TurnNotify({
  useSession,
  useProjection,
}: {
  useSession?: UseSessionHook;
  useProjection?: UseProjectionHook;
}) {
  const session = useSession?.((snapshot) => snapshot) as
    | SessionLike
    | undefined;
  const title = useProjection?.("title") ?? null;

  const runningRef = useRef(false);
  const sessionRef = useRef<SessionLike | undefined>(undefined);
  const titleRef = useRef<string | null>(null);
  const prevRunningRef = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    runningRef.current = session?.running === true;
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    ensurePermission();
  }, []);

  useEffect(() => {
    const running = session?.running === true;
    const previous = prevRunningRef.current;
    prevRunningRef.current = running;
    if (previous !== true || running !== false) return;
    // 回合结束：短暂观察期内若排队消息开启了新轮次，则不通知。
    const timer = setTimeout(() => {
      if (runningRef.current) return;
      if (!document.hidden) return;
      fire(sessionRef.current, titleRef.current);
    }, NOTIFY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [session]);

  return null as unknown as ReactNode;
}
