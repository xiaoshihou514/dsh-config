/**
 * 提权自动审批的配置卡片（设置 → 插件），视觉与交互对齐 dsh-vision 卡片：
 * 官方 PluginCard 外壳（可折叠头部 + 未保存徽标 + 放弃/保存）+ 密钥字段
 * （底部带获取 Key 的链接）。只负责填 Key；模式开关在 composer 权限选择器
 * 的第四个预设（`auto-approve`，由 permission-presets 配置补丁提供）——
 * 未配置 Key 时该模式不生效（提权照旧询问）。
 */

import { useEffect, useState } from "react";
import type { IApiClient } from "@deepseek-ai/dsh-client-connection/client";
import { IconChevronDownOutline14 } from "./icons.tsx";

const KEY_REF = "ZHIPU_API_KEY";
const KEY_PAGE = "https://bigmodel.cn/usercenter/proj-mgmt/apikeys";

export interface ApprovalReviewCardInjected {
  api: Pick<IApiClient, "credentials">;
}

interface CredentialView {
  configured?: boolean;
}

export function ApprovalReviewCard({ api }: ApprovalReviewCardInjected) {
  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const refresh = async () => {
    const described = await api.credentials.describe({ refs: [KEY_REF] }).catch(() => undefined) as
      | { result: { ok: boolean; value: { credentials: Record<string, CredentialView> } } }
      | undefined;
    if (described?.result.ok === true) {
      setConfigured(described.result.value.credentials[KEY_REF]?.configured === true);
    }
    setLoaded(true);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const dirty = !loaded || keyDraft.trim() !== "";
  const blocked = !dirty || saving;

  const save = async () => {
    setSaving(true);
    setFailed(false);
    try {
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
    setKeyDraft("");
    setFailed(false);
  };

  return <li style={{ listStyle: "none", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12, background: "var(--dsw-alias-bg-layer-3)", transition: "border-color .16s, background .16s", ...(open ? { background: "var(--dsw-alias-bg-layer-2)", borderColor: "var(--dsw-alias-label-dimmed)" } : {}) }}>
    <button
      type="button"
      aria-expanded={open}
      aria-label={`${open ? "收起" : "展开"}: 提权自动审批`}
      onClick={() => { setOpen(!open); }}
      style={{ width: "100%", appearance: "none", border: 0, background: "none", font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderRadius: 12 }}
    >
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4, color: "var(--dsw-alias-label-primary)" }}>自动模式</span>
      </span>
      {dirty ? <span style={{ flex: "none", borderRadius: 999, padding: "1px 8px", fontSize: 11, lineHeight: "17px", fontWeight: 500, whiteSpace: "nowrap", background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-secondary)" }}>未保存</span> : null}
      <span style={{ flex: "none", color: "var(--dsw-alias-label-tertiary)", transition: "transform .16s", transform: open ? "rotate(180deg)" : undefined, display: "inline-flex" }}>
        <IconChevronDownOutline14 size={14} />
      </span>
    </button>
    {open ? <div style={{ borderTop: "1px solid var(--dsw-alias-border-l2)", margin: "0 16px", paddingBottom: 8 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "12px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, lineHeight: 1.5, color: "var(--dsw-alias-label-primary)" }}>智谱 API Key</span>
          <span style={{ borderRadius: 999, padding: "1px 8px", fontSize: 11, lineHeight: "17px", whiteSpace: "nowrap", fontWeight: 500, background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-secondary)" }}>
            {configured ? "已配置" : "未配置"}
          </span>
        </div>
        <input
          type="password"
          autoComplete="off"
          value={keyDraft}
          onChange={(event) => { setKeyDraft(event.target.value); }}
          placeholder={configured ? "输入新 Key 以替换" : "粘贴智谱 API Key"}
          style={{ height: 34, padding: "0 12px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, background: "var(--dsw-alias-bg-layer-3)", font: "inherit", fontSize: 13, lineHeight: 1.5, color: "var(--dsw-alias-label-primary)" }}
        />
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary)" }}>
          存储在 ZHIPU_API_KEY 凭据中，不会回传到浏览器。{' '}
          <a href={KEY_PAGE} target="_blank" rel="noreferrer" style={{ color: "var(--dsw-alias-label-primary-bluish)" }}>前往 bigmodel.cn 获取免费 Key</a>
        </p>
        {!configured ? <p role="status" style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--dsw-alias-state-warn-primary)" }}>未配置 Key 前，「自动审批」模式不会生效，提权会照常询问你。</p> : null}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, padding: "12px 0 4px", borderTop: "1px solid var(--dsw-alias-border-l2)" }}>
        {failed ? <p role="status" style={{ flex: 1, minWidth: 0, margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--dsw-alias-label-error)" }}>保存失败，请重试。</p> : null}
        <button type="button" disabled={blocked} onClick={discard} style={{ appearance: "none", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, padding: "5px 14px", font: "inherit", fontSize: 13, lineHeight: 1.5, cursor: "pointer", background: "none", color: "var(--dsw-alias-label-secondary)", opacity: blocked ? 0.4 : 1 }}>放弃</button>
        <button type="button" disabled={blocked} onClick={() => void save()} style={{ appearance: "none", border: "1px solid transparent", borderRadius: 8, padding: "5px 14px", font: "inherit", fontSize: 13, lineHeight: 1.5, cursor: "pointer", background: "var(--dsw-alias-label-primary)", color: "var(--dsw-alias-bg-layer-3)", opacity: blocked ? 0.4 : 1 }}>{saving ? "保存中…" : "保存"}</button>
      </div>
    </div> : null}
  </li>;
}
