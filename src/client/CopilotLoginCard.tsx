import { useEffect, useState } from "react";
import { IconChevronDownOutline14 } from "./icons.tsx";

const HEADER = { "x-dsh-config": "copilot-login" };

type LoginStatus =
  | { state: "idle"; message?: undefined; url?: undefined; userCode?: undefined }
  | { state: "pending"; message?: undefined; url?: string; userCode?: string }
  | { state: "success"; message?: undefined; url?: undefined; userCode?: undefined }
  | { state: "error"; message: string; url?: undefined; userCode?: undefined };

async function request(
  method: "GET" | "POST" | "DELETE",
): Promise<LoginStatus> {
  const response = await fetch("/dsh-config/copilot-login", {
    method,
    headers: HEADER,
  });
  const body = (await response.json()) as LoginStatus & { ok?: boolean };
  if (!response.ok || body.ok === false)
    throw new Error(body.message ?? "登录请求失败");
  return body;
}

export function CopilotLoginCard() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<LoginStatus>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<"url" | "code" | null>(null);

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
    setCopied(null);
    try {
      const next = await request("POST");
      setStatus(next);
      // 设备码流程：收到验证码后自动打开 GitHub 验证页；被拦截时链接仍在
      // 卡片里，可点击或复制到任意浏览器/设备。
      if (next.state === "pending" && next.url !== undefined)
        window.open(next.url, "_blank");
    } catch (error) {
      setStatus({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const copy = async (kind: "url" | "code", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      /* 剪贴板不可用时静默（内容仍可直接点击/选中） */
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
    <div
      style={{
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 12,
        background: "var(--dsw-alias-bg-layer-3)",
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "收起" : "展开"}：Copilot 订阅`}
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
            Copilot 订阅
          </span>
          <span
            style={{ fontSize: 13, color: "var(--dsw-alias-label-tertiary)" }}
          >
            使用 GitHub 设备码登录并调用 Copilot 模型
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
            点击后将在新窗口打开 GitHub 验证页面，输入卡片里显示的设备码即可完成授权。凭据只保存在本机配置目录中，不会发送到浏览器前端。
          </p>
          {status.state === "pending" ? (
            <div
              role="status"
              style={{
                margin: 0,
                display: "flex",
                flexDirection: "column",
                gap: 8,
                fontSize: 12,
                color: "var(--dsw-alias-label-secondary)",
              }}
            >
              <p style={{ margin: 0, lineHeight: 1.5 }}>
                请在新打开的页面中输入下面的设备码；如果弹窗被拦截或想用其他
                浏览器/设备，请手动打开验证链接：
              </p>
              {status.userCode !== undefined ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <code
                    style={{
                      fontFamily: "monospace",
                      fontSize: 16,
                      fontWeight: 700,
                      letterSpacing: 2,
                      color: "var(--dsw-alias-label-primary)",
                    }}
                  >
                    {status.userCode}
                  </code>
                  <button
                    type="button"
                    onClick={() =>
                      status.userCode !== undefined &&
                      void copy("code", status.userCode)
                    }
                    style={{
                      appearance: "none",
                      border: "1px solid var(--dsw-alias-border-l2)",
                      borderRadius: 6,
                      padding: "3px 10px",
                      font: "inherit",
                      fontSize: 12,
                      cursor: "pointer",
                      background: "var(--dsw-alias-bg-layer-3)",
                      color: "var(--dsw-alias-label-secondary)",
                      flexShrink: 0,
                    }}
                  >
                    {copied === "code" ? "已复制" : "复制设备码"}
                  </button>
                </div>
              ) : null}
              {status.url !== undefined ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <a
                    href={status.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      fontFamily: "monospace",
                      fontSize: 12,
                      lineHeight: 1.4,
                      color: "inherit",
                      textDecoration: "underline",
                      wordBreak: "break-all",
                      maxWidth: "100%",
                    }}
                  >
                    {status.url}
                  </a>
                  <button
                    type="button"
                    onClick={() =>
                      status.url !== undefined && void copy("url", status.url)
                    }
                    style={{
                      appearance: "none",
                      border: "1px solid var(--dsw-alias-border-l2)",
                      borderRadius: 6,
                      padding: "3px 10px",
                      font: "inherit",
                      fontSize: 12,
                      cursor: "pointer",
                      background: "var(--dsw-alias-bg-layer-3)",
                      color: "var(--dsw-alias-label-secondary)",
                      flexShrink: 0,
                    }}
                  >
                    {copied === "url" ? "已复制" : "复制链接"}
                  </button>
                </div>
              ) : null}
            </div>
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
                  : "使用 GitHub 登录"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
