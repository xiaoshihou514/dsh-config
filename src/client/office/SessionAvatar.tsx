/**
 * 对话界面角色头像：当前会话所用模型对应厂商的角色头像（人设立绘头部），
 * 模型切换时实时更新。
 *
 * 挂两处（由客户端入口注册）：
 * - `conversation.header.leading`：已开会话时在标题左侧；
 * - `conversation.hero.brand.mark`：新会话欢迎页在标语左侧（替换内置鱼标）。
 *
 * 模型来源：当前会话的模型选择投影 `modelSelection.next`（会话自选的模型）；
 * 会话没选过、或还没有会话时，用宿主模型目录的全局默认模型；都拿不到时显示兜帽旅人。
 */

import { useEffect, useMemo, useState } from "react";
import { TIER_LABEL, VENDOR_LABEL, tierOf, vendorOf } from "../../office/classify.ts";
import type { Vendor } from "../../office/types.ts";
import { PERSONA_AVATARS } from "./avatars.generated.ts";
import { currentSession } from "./store.ts";

/** 模型选择（与宿主 `ModelSelection` 同形）。 */
export interface ModelChoice {
  readonly provider: string;
  readonly model: string;
}

/** 入口注入的宿主能力：读全局默认模型（宿主模型目录的 `default`）。 */
export const avatarHost: { current: { loadDefault(): Promise<ModelChoice | undefined> } | undefined } = {
  current: undefined,
};

// ---------------------------------------------------------------- 全局默认模型

let defaultModel: ModelChoice | undefined;
let defaultLoading: Promise<void> | undefined;
const defaultListeners = new Set<() => void>();

/** 读一次全局默认模型（失败或宿主能力未就绪时下次再试）。 */
function ensureDefault(): void {
  if (defaultModel !== undefined || defaultLoading !== undefined) return;
  const host = avatarHost.current;
  if (host === undefined) return;
  defaultLoading = host
    .loadDefault()
    .then((value) => {
      if (value === undefined) return;
      defaultModel = value;
      for (const listener of defaultListeners) listener();
    })
    .catch(() => {})
    .finally(() => {
      defaultLoading = undefined;
    });
}

function useDefaultModel(): ModelChoice | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((v) => v + 1);
    defaultListeners.add(listener);
    ensureDefault();
    // 宿主能力可能晚于组件就绪：没拿到时隔一会儿重试
    const timer = defaultModel === undefined ? setInterval(ensureDefault, 3000) : undefined;
    return () => {
      defaultListeners.delete(listener);
      if (timer !== undefined) clearInterval(timer);
    };
  }, []);
  return defaultModel;
}

// ---------------------------------------------------------------- 当前会话

/** `useSessions` 的状态里用到的部分（宽松类型：宿主结构变化时只是取不到）。 */
interface SessionsLike {
  readonly byId?: Readonly<Record<string, { readonly retainedBy?: { readonly mainView?: number } } | undefined>>;
  readonly projectionsBySession?: Readonly<
    Record<string, { readonly values?: { readonly modelSelection?: { readonly next?: ModelChoice } } } | undefined>
  >;
}
type UseSessions = <T>(selector: (state: SessionsLike | undefined) => T) => T;

/** 原生当前会话：会话列表里被主视图持有的那条；取不到时退回工作区持久化的选择。 */
function currentId(state: SessionsLike | undefined): string | undefined {
  for (const [id, row] of Object.entries(state?.byId ?? {})) if ((row?.retainedBy?.mainView ?? 0) > 0) return id;
  return currentSession().sessionId;
}

/** 当前会话自选的模型（`provider/model`）；没有返回空串。按串比较，避免对象每次都是新的。 */
function selectedKey(state: SessionsLike | undefined, sessionId: string | undefined): string {
  if (sessionId === undefined) return "";
  const next = state?.projectionsBySession?.[sessionId]?.values?.modelSelection?.next;
  return next === undefined ? "" : `${next.provider}\u0000${next.model}`;
}

// ---------------------------------------------------------------- 组件

export interface AvatarInfo {
  readonly vendor: Vendor;
  readonly title: string;
}

/** 由模型推算头像与提示文字（纯函数，便于测试）。 */
export function avatarFor(model: ModelChoice | undefined, fromDefault: boolean): AvatarInfo {
  if (model === undefined) return { vendor: "other", title: "未知模型" };
  const vendor = vendorOf(model.provider, model.model);
  const tier = TIER_LABEL[tierOf(model.model)];
  return {
    vendor,
    title: `${VENDOR_LABEL[vendor]}（${tier}）· ${model.model}${fromDefault ? " · 默认模型" : ""}`,
  };
}

function useAvatar(useSessions: UseSessions | undefined, hero: boolean): AvatarInfo {
  const fallback = useDefaultModel();
  // 欢迎页还没有会话：只看默认模型
  const sessionId = useSessions?.((state) => (hero ? undefined : currentId(state)));
  const key = useSessions?.((state) => selectedKey(state, hero ? undefined : currentId(state))) ?? "";
  // localStorage 里的选择变化（另一标签页或宿主未提供 mainView 时）也要跟上
  const [, bump] = useState(0);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === "dsh.sessions.current") bump((v) => v + 1);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return useMemo(() => {
    if (key !== "") {
      const [provider, model] = key.split("\u0000") as [string, string];
      return avatarFor({ provider, model }, false);
    }
    return avatarFor(fallback, true);
    // sessionId 参与依赖：切换会话时重算
  }, [key, fallback, sessionId]);
}

const STYLE = {
  header: {
    width: 30,
    height: 30,
    margin: "0 4px 0 2px",
  },
  hero: {
    width: 40,
    height: 40,
    margin: 0,
  },
} as const;

function Avatar({ info, size }: { info: AvatarInfo; size: "header" | "hero" }) {
  const box = STYLE[size];
  const pixel = info.vendor === "other";
  return (
    <img
      src={PERSONA_AVATARS[info.vendor]}
      alt={info.title}
      title={info.title}
      draggable={false}
      data-dsh-config-avatar={info.vendor}
      style={{
        ...box,
        flex: "none",
        display: "block",
        borderRadius: "50%",
        objectFit: "cover",
        boxShadow: "0 0 0 1.5px var(--dsw-alias-border-l2, rgba(0,0,0,.12)), 0 1px 3px rgba(0,0,0,.12)",
        background: "var(--dsw-alias-bg-base, #fff)",
        imageRendering: pixel ? "pixelated" : "auto",
        userSelect: "none",
        // 头部是可拖动的窗口区域：头像本身不拦拖动
        pointerEvents: "auto",
      }}
    />
  );
}

/** `conversation.header.leading`：会话标题左侧的头像。 */
export function HeaderAvatar({ useSessions }: { useSessions?: UseSessions }) {
  const info = useAvatar(useSessions, false);
  return <Avatar info={info} size="header" />;
}

/** `conversation.hero.brand.mark`：新会话欢迎页标语左侧的头像（替换内置鱼标）。 */
export function HeroAvatar({ useSessions }: { useSessions?: UseSessions; size?: number; className?: string }) {
  const info = useAvatar(useSessions, true);
  return <Avatar info={info} size="hero" />;
}
