/**
 * 对话界面角色头像：当前会话所用模型对应厂商的角色头像（像素版，与办公室体素角色同一张正视图），
 * 模型切换时实时更新。
 *
 * 挂两处（由客户端入口注册），同一时刻只出现一处：
 * - `conversation.input.overlay`：已开始的会话，作为独立元素站在消息输入框左侧（48px，不与框重叠，
 *   垂直居中对齐输入框）；
 * - `conversation.hero.brand.mark`：新会话欢迎页在标语左侧（40px，替换内置鱼标），
 *   此时输入框那处不显示。
 *
 * 模型来源：当前会话的模型选择投影 `modelSelection.next`（会话自选的模型）；
 * 会话没选过、或还没有会话时，用宿主模型目录的全局默认模型；都拿不到时显示兜帽旅人。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
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

/**
 * @param explicit - 槽位给出的会话 id（会话作用域槽位）；缺省时按原生当前会话推断。
 * @param hero - 欢迎页：还没有会话，只看默认模型。
 */
function useAvatar(useSessions: UseSessions | undefined, hero: boolean, explicit?: string): AvatarInfo {
  const fallback = useDefaultModel();
  const pick = (state: SessionsLike | undefined) => (hero ? undefined : (explicit ?? currentId(state)));
  const sessionId = useSessions?.(pick);
  const key = useSessions?.((state) => selectedKey(state, pick(state))) ?? "";
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

/** 头像边长（输入框处）。 */
const COMPOSER_SIZE = 48;
/** 头像与输入框的间距。 */
const COMPOSER_GAP = 12;

const STYLE: Record<"side" | "above" | "hero", CSSProperties> = {
  /** 输入框左侧外沿：独立站在框旁，垂直位置由测量结果给出（与输入框居中对齐）。 */
  side: {
    width: COMPOSER_SIZE,
    height: COMPOSER_SIZE,
    position: "absolute",
    left: -(COMPOSER_SIZE + COMPOSER_GAP),
    zIndex: 2,
  },
  /** 左侧放不下（窄窗口）：站在输入框左上方，不压框。 */
  above: {
    width: COMPOSER_SIZE,
    height: COMPOSER_SIZE,
    position: "absolute",
    left: 4,
    top: -(COMPOSER_SIZE + 6),
    zIndex: 2,
  },
  hero: {
    width: 40,
    height: 40,
    margin: 0,
  },
} as const;

function Avatar({
  info,
  size,
  imgRef,
  top,
}: {
  info: AvatarInfo;
  size: "side" | "above" | "hero";
  imgRef?: RefObject<HTMLImageElement>;
  top?: number | undefined;
}) {
  const box = top === undefined ? STYLE[size] : { ...STYLE[size], top };
  return (
    <img
      ref={imgRef}
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
        // 像素头像一格一像素：最近邻放大，保持锐利
        imageRendering: "pixelated",
        userSelect: "none",
        pointerEvents: "auto",
      }}
    />
  );
}

/**
 * `conversation.input.overlay`：消息输入框左上角的头像。新会话（还没发过消息）时不显示——
 * 欢迎页标语旁已有一处。
 */
export function ComposerAvatar({
  sessionId,
  useSession,
  useSessions,
}: {
  sessionId?: string;
  useSession?: <T>(selector: (state: { readonly blank?: boolean } | undefined) => T) => T;
  useSessions?: UseSessions;
}) {
  const blank = useSession?.((state) => state?.blank === true) ?? false;
  const info = useAvatar(useSessions, false, sessionId);
  const ref = useRef<HTMLImageElement>(null);
  const [place, setPlace] = useState<Placement>({ at: "side", top: 0 });
  useLayoutEffect(() => {
    if (blank) return;
    const check = () => {
      const card = ref.current?.closest<HTMLElement>("[data-composer-card]");
      const next: Placement = card === null || card === undefined ? { at: "side", top: 0 } : placeFor(card);
      setPlace((prev) => (prev.at === next.at && prev.top === next.top ? prev : next));
    };
    check();
    // 输入框随草稿变高、停靠条随时出现 / 消失：低频复查即可
    const timer = setInterval(check, 700);
    window.addEventListener("resize", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("resize", check);
    };
  }, [blank]);
  if (blank) return null;
  return <Avatar info={info} size={place.at} imgRef={ref} top={place.at === "side" ? place.top : undefined} />;
}

interface Placement {
  readonly at: "side" | "above";
  /** side 时相对卡片顶边的位置（使头像与输入框垂直居中）。 */
  readonly top: number;
}

/**
 * 默认站在输入框左侧外沿、与输入框垂直居中。左侧放不下（窄窗口）时站到输入框左上方——
 * 但上方紧挨着有停靠条（输入框根节点之前的兄弟节点、有高度、贴近卡片顶边）时那里会压住停靠条，
 * 仍留在左侧（贴边）。
 */
function placeFor(card: HTMLElement): Placement {
  const rect = card.getBoundingClientRect();
  const top = Math.round((rect.height - COMPOSER_SIZE) / 2);
  const root = card.parentElement;
  const bound = (card.closest<HTMLElement>('[class*="_composerSeat"]') ?? root?.parentElement ?? null)?.getBoundingClientRect();
  const room = rect.left - (bound?.left ?? 0);
  if (room >= COMPOSER_SIZE + COMPOSER_GAP) return { at: "side", top };
  for (let el = root?.previousElementSibling ?? null; el !== null; el = el.previousElementSibling) {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && rect.top - r.bottom < 24) return { at: "side", top };
  }
  return { at: "above", top: 0 };
}

/** @deprecated 标题左侧的头像已移到输入框左上角（{@link ComposerAvatar}）；保留空实现，入口撤掉注册前不显示。 */
export function HeaderAvatar(_props: { useSessions?: UseSessions }) {
  return null;
}

/** `conversation.hero.brand.mark`：新会话欢迎页标语左侧的头像（替换内置鱼标）。 */
export function HeroAvatar({ useSessions }: { useSessions?: UseSessions; size?: number; className?: string }) {
  const info = useAvatar(useSessions, true);
  return <Avatar info={info} size="hero" />;
}
