/**
 * 提权自动审批的配置卡片（设置 → 插件），视觉与交互对齐 dsh-vision 卡片：
 * 官方 PluginCard 外壳（可折叠头部 + 未保存徽标 + 放弃/保存）。
 * 配置项：智谱 API Key（可选，留空=免密）+ OpenCode Free 回退模型选择
 * （自动审批先试智谱，失败自动换到所选的 opencode 免费模型）。
 */

import { useEffect, useState } from "react";
import type { IApiClient } from "@deepseek-ai/dsh-client-connection/client";
import type { SettingsScope } from "@deepseek-ai/dsh-client-runtime/client";
import { IconChevronDownOutline14 } from "./icons.tsx";

const KEY_REF = "ZHIPU_API_KEY";
const KEY_PAGE = "https://bigmodel.cn/usercenter/proj-mgmt/apikeys";
const DEFAULT_FALLBACK_MODEL = "deepseek-v4-flash-free";
const MODELS_HEADER = { "x-dsh-config": "auto-approval" };

export interface ApprovalReviewSettings {
  fallbackModel?: string;
}

export interface ApprovalReviewCardInjected {
  scope: SettingsScope<ApprovalReviewSettings>;
  api: Pick<IApiClient, "credentials">;
}

interface CredentialView {
  configured?: boolean;
}

export function ApprovalReviewCard({ scope, api }: ApprovalReviewCardInjected) {
  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [savedModel, setSavedModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const refresh = async () => {
    const snapshot = scope.getSnapshot();
    const current = snapshot.value?.fallbackModel ?? "";
    setModelDraft(current);
    setSavedModel(current);
    const described = (await api.credentials
      .describe({ refs: [KEY_REF] })
      .catch(() => undefined)) as
      | {
          result: {
            ok: boolean;
            value: { credentials: Record<string, CredentialView> };
          };
        }
      | undefined;
    if (described?.result.ok === true) {
      setConfigured(
        described.result.value.credentials[KEY_REF]?.configured === true,
      );
    }
    const fetched = await fetch("/dsh-config/opencode-models", {
      headers: MODELS_HEADER,
    })
      .then(
        (response) =>
          response.json() as Promise<{ ok?: boolean; models?: string[] }>,
      )
      .catch(() => undefined);
    const list =
      fetched?.ok === true && Array.isArray(fetched.models)
        ? fetched.models
        : [];
    if (current !== "" && !list.includes(current)) list.unshift(current);
    setModels(list);
    setLoaded(true);
  };

  useEffect(() => {
    void refresh();
    const unsubscribe = scope.subscribe(() => {
      void refresh();
    });
    return unsubscribe;
  }, []);

  const dirty = !loaded || keyDraft.trim() !== "" || modelDraft !== savedModel;
  const blocked = !dirty || saving;

  const save = async () => {
    setSaving(true);
    setFailed(false);
    try {
      await scope.set("fallbackModel", modelDraft);
      if (keyDraft.trim() !== "") {
        await api.credentials.set({ ref: KEY_REF, value: keyDraft.trim() });
      }
      setKeyDraft("");
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setModelDraft(savedModel);
    setKeyDraft("");
    setFailed(false);
  };

  return (
    <li
      style={{
        listStyle: "none",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 12,
        background: "var(--dsw-alias-bg-layer-3)",
        transition: "border-color .16s, background .16s",
        ...(open
          ? {
              background: "var(--dsw-alias-bg-layer-2)",
              borderColor: "var(--dsw-alias-label-dimmed)",
            }
          : {}),
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "收起" : "展开"}: 自动模式`}
        onClick={() => {
          setOpen(!open);
        }}
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
              lineHeight: 1.4,
              color: "var(--dsw-alias-label-primary)",
            }}
          >
            自动模式
          </span>
          <span
            style={{
              fontSize: 13,
              lineHeight: 1.5,
              color: "var(--dsw-alias-label-tertiary)",
            }}
          >
            提权回先经大模型尝试自动审核
          </span>
        </span>
        {dirty ? (
          <span
            style={{
              flex: "none",
              borderRadius: 999,
              padding: "1px 8px",
              fontSize: 11,
              lineHeight: "17px",
              fontWeight: 500,
              whiteSpace: "nowrap",
              background: "var(--dsw-alias-bg-module-platform)",
              color: "var(--dsw-alias-label-secondary)",
            }}
          >
            未保存
          </span>
        ) : null}
        <span
          style={{
            flex: "none",
            color: "var(--dsw-alias-label-tertiary)",
            transition: "transform .16s",
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
            paddingBottom: 8,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: "12px 0",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 13,
                  fontWeight: 500,
                  lineHeight: 1.5,
                  color: "var(--dsw-alias-label-primary)",
                }}
              >
                OpenCode Free 模型
              </span>
            </div>
            <select
              value={modelDraft}
              onChange={(event) => {
                setModelDraft(event.target.value);
              }}
              style={{
                height: 34,
                padding: "0 12px",
                border: "1px solid var(--dsw-alias-border-l2)",
                borderRadius: 8,
                background: "var(--dsw-alias-bg-layer-3)",
                font: "inherit",
                fontSize: 13,
                lineHeight: 1.5,
                color: "var(--dsw-alias-label-primary)",
              }}
            >
              <option value="">默认（{DEFAULT_FALLBACK_MODEL}）</option>
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: "12px 0",
              borderTop: "1px solid var(--dsw-alias-border-l2)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 13,
                  fontWeight: 500,
                  lineHeight: 1.5,
                  color: "var(--dsw-alias-label-primary)",
                }}
              >
                智谱密钥
              </span>
              <span
                style={{
                  borderRadius: 999,
                  padding: "1px 8px",
                  fontSize: 11,
                  lineHeight: "17px",
                  whiteSpace: "nowrap",
                  fontWeight: 500,
                  background: "var(--dsw-alias-bg-module-platform)",
                  color: "var(--dsw-alias-label-secondary)",
                }}
              >
                {configured ? "已配置" : "未配置"}
              </span>
            </div>
            <input
              type="password"
              autoComplete="off"
              value={keyDraft}
              onChange={(event) => {
                setKeyDraft(event.target.value);
              }}
              placeholder={
                configured ? "输入新 Key 以替换" : "粘贴智谱 API Key"
              }
              style={{
                height: 34,
                padding: "0 12px",
                border: "1px solid var(--dsw-alias-border-l2)",
                borderRadius: 8,
                background: "var(--dsw-alias-bg-layer-3)",
                font: "inherit",
                fontSize: 13,
                lineHeight: 1.5,
                color: "var(--dsw-alias-label-primary)",
              }}
            />
            <p
              style={{
                margin: 0,
                fontSize: 12,
                lineHeight: 1.5,
                color: "var(--dsw-alias-label-tertiary)",
              }}
            >
              留空则跳过智谱、直接走 OpenCode Free。{" "}
              <a
                href={KEY_PAGE}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--dsw-alias-label-primary-bluish)" }}
              >
                前往 bigmodel.cn 免费获取密钥
              </a>
            </p>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: 8,
              padding: "12px 0 4px",
              borderTop: "1px solid var(--dsw-alias-border-l2)",
            }}
          >
            {failed ? (
              <p
                role="status"
                style={{
                  flex: 1,
                  minWidth: 0,
                  margin: 0,
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: "var(--dsw-alias-label-error)",
                }}
              >
                保存失败，请重试。
              </p>
            ) : null}
            <button
              type="button"
              disabled={blocked}
              onClick={discard}
              style={{
                appearance: "none",
                border: "1px solid var(--dsw-alias-border-l2)",
                borderRadius: 8,
                padding: "5px 14px",
                font: "inherit",
                fontSize: 13,
                lineHeight: 1.5,
                cursor: "pointer",
                background: "none",
                color: "var(--dsw-alias-label-secondary)",
                opacity: blocked ? 0.4 : 1,
              }}
            >
              放弃
            </button>
            <button
              type="button"
              disabled={blocked}
              onClick={() => void save()}
              style={{
                appearance: "none",
                border: "1px solid transparent",
                borderRadius: 8,
                padding: "5px 14px",
                font: "inherit",
                fontSize: 13,
                lineHeight: 1.5,
                cursor: "pointer",
                background: "var(--dsw-alias-label-primary)",
                color: "var(--dsw-alias-bg-layer-3)",
                opacity: blocked ? 0.4 : 1,
              }}
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
