import { useEffect, useState } from "react";
import { IconChevronDownOutline14 } from "./icons.tsx";

const HEADER = { "x-dsh-config": "codex-login" };

type LoginStatus =
  | { state: "idle"; message?: undefined; url?: undefined }
  | { state: "pending"; message?: undefined; url?: string }
  | { state: "success"; message?: undefined; url?: undefined }
  | { state: "error"; message: string; url?: undefined };

async function request(
  method: "GET" | "POST" | "DELETE",
): Promise<LoginStatus> {
  const response = await fetch("/dsh-config/codex-login", {
    method,
    headers: HEADER,
  });
  const body = (await response.json()) as LoginStatus & { ok?: boolean };
  if (!response.ok || body.ok === false)
    throw new Error(body.message ?? "登录请求失败");
  return body;
}

export function CodexLoginCard() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<LoginStatus>({ state: "idle" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void request("GET")
      .then(setStatus)
      .catch(() => {
        /* 后端不可达时保持未登录 */
      });
  }, []);

  useEffect(() => {
    if (status.state !== "pending") return;
    const timer = window.setInterval(() => {
      void request("GET")
        .then(setStatus)
        .catch((error: unknown) => {
          setStatus({
            state: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [status.state]);

  const login = async () => {
    if (busy) return;
    setBusy(true);
    const popup = window.open("", "_blank");
    try {
      const next = await request("POST");
      setStatus(next);
      if (next.state === "pending" && next.url !== undefined) {
        if (popup !== null) popup.location.href = next.url;
        else window.open(next.url, "_blank", "noopener,noreferrer");
      } else {
        popup?.close();
      }
    } catch (error) {
      popup?.close();
      setStatus({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const label =
    status.state === "success"
      ? "已登录"
      : status.state === "pending"
        ? "等待登录"
        : status.state === "error"
          ? "登录失败"
          : "未登录";

  return (
    <li
      style={{
        listStyle: "none",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 12,
        background: "var(--dsw-alias-bg-layer-3)",
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "收起" : "展开"}：Codex 订阅`}
        onClick={() => setOpen(!open)}
        style={{
          width: "100%",
          appearance: "none",
          border: 0,
          background: "none",
          font: "inherit",
          color: "inherit",
          textAlign: "left",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "14px 16px",
          borderRadius: 12,
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <span
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: "var(--dsw-alias-label-primary)",
            }}
          >
            Codex 订阅
          </span>
          <span
            style={{ fontSize: 13, color: "var(--dsw-alias-label-tertiary)" }}
          >
            使用 ChatGPT 订阅登录并调用 Codex 模型
          </span>
        </span>
        <span
          style={{
            borderRadius: 999,
            padding: "1px 8px",
            fontSize: 11,
            background: "var(--dsw-alias-bg-module-platform)",
            color: "var(--dsw-alias-label-secondary)",
          }}
        >
          {label}
        </span>
        <span
          style={{
            color: "var(--dsw-alias-label-tertiary)",
            transform: open ? "rotate(180deg)" : undefined,
            display: "inline-flex",
          }}
        >
          <IconChevronDownOutline14 size={14} />
        </span>
      </button>
      {open ? (
        <div
          style={{
            borderTop: "1px solid var(--dsw-alias-border-l2)",
            margin: "0 16px",
            padding: "14px 0 16px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: 12,
              lineHeight: 1.5,
              color: "var(--dsw-alias-label-tertiary)",
            }}
          >
            点击后将在新窗口打开 OpenAI 登录页面。凭据只保存在本机 Codex
            配置目录中，不会发送到浏览器前端。
          </p>
          {status.state === "pending" ? (
            <p
              role="status"
              style={{
                margin: 0,
                fontSize: 12,
                color: "var(--dsw-alias-label-secondary)",
              }}
            >
              请在新窗口中完成登录，此页面会自动更新。
            </p>
          ) : null}
          {status.state === "error" ? (
            <p
              role="alert"
              style={{
                margin: 0,
                fontSize: 12,
                color: "var(--dsw-alias-label-error)",
              }}
            >
              {status.message}
            </p>
          ) : null}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              disabled={busy || status.state === "pending"}
              onClick={() => void login()}
              style={{
                appearance: "none",
                border: "1px solid transparent",
                borderRadius: 8,
                padding: "6px 14px",
                font: "inherit",
                fontSize: 13,
                cursor: busy ? "wait" : "pointer",
                background: "var(--dsw-alias-label-primary)",
                color: "var(--dsw-alias-bg-layer-3)",
                opacity: busy || status.state === "pending" ? 0.5 : 1,
              }}
            >
              {busy
                ? "正在发起…"
                : status.state === "success"
                  ? "重新登录"
                  : "使用 ChatGPT 登录"}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
