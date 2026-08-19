/** 输入栏权限选择器旁的自动审批开关（conversation.input.left，session 作用域）。 */

import { useEffect, useState } from "react";
import { IconSparkle16 } from "./icons.tsx";

const HEADER = { "x-dsh-config": "auto-approval" };

/** 按会话切换自动审批：开启后该会话的提权先经智谱免费模型审核。 */
export function AutoApproveToggle({ sessionId }: { sessionId?: string }) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    setEnabled(false);
    if (sessionId === undefined) return;
    let stale = false;
    const controller = new AbortController();
    void fetch(
      `/dsh-config/auto-approval?session=${encodeURIComponent(sessionId)}`,
      {
        headers: HEADER,
        signal: controller.signal,
      },
    )
      .then(
        (response) =>
          response.json() as Promise<{ ok?: boolean; enabled?: boolean }>,
      )
      .then((payload) => {
        if (!stale && payload.ok === true) setEnabled(payload.enabled === true);
      })
      .catch(() => {
        /* 宿主不可达时保持关闭 */
      });
    return () => {
      stale = true;
      controller.abort();
    };
  }, [sessionId]);

  const toggle = async () => {
    if (sessionId === undefined || busy) return;
    setBusy(true);
    const next = !enabled;
    setEnabled(next); // 乐观更新：点击立即反馈
    try {
      const response = await fetch("/dsh-config/auto-approval", {
        method: "PUT",
        headers: { "content-type": "application/json", ...HEADER },
        body: JSON.stringify({ session: sessionId, enabled: next }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        enabled?: boolean;
      };
      if (payload.ok !== true) setEnabled(!next); // 失败回滚
    } catch {
      setEnabled(!next); // 网络失败回滚
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      aria-pressed={enabled}
      aria-label={enabled ? "自动审批已开启" : "自动审批已关闭"}
      title={enabled ? "自动审批已开启" : "自动审批已关闭"}
      onClick={() => void toggle()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      disabled={sessionId === undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        height: 28,
        minWidth: 28,
        padding: "0 8px",
        border: "none",
        borderRadius: 24,
        cursor: busy ? "wait" : "pointer",
        background: enabled
          ? "color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)"
          : "var(--dsw-alias-interactive-bg-hover)",
        color: enabled
          ? "var(--dsw-alias-state-business-primary)"
          : "var(--dsw-alias-label-secondary)",
        opacity: busy ? 0.7 : 1,
        transition: "background .16s, color .16s, opacity .16s",
      }}
    >
      <IconSparkle16 size={14} />
    </button>
  );
}
