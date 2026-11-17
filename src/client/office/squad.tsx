/**
 * 游戏风的势力 / 编队小部件（项目面板、老板办公室共用），与 HUD 同一套语言：渐变方块、底部压边、像素画。
 *
 * - `Squad`：编队——一个像素小人一个单位（组长戴金冠排第一，组员 / 单智能体跟后）；在跑的亮绿、
 *   空闲的灰暗。子代理不占位（它在跑只让派它的单位亮）。数字只在悬停提示里。
 * - `Seal`：状态徽章——干活中是绿色方块里跳动的像素柱，休整是灰色方块里的月牙；老板办公室另有
 *   汇报（金色信封）、出错（红色感叹号）、等组员（蓝色沙漏）。
 * - `Tally`：计数徽章（徽章 + 数字），用于触发按钮与面板抬头。
 */

import { createContext, useContext } from "react";
import type { Vendor } from "../../office/types.ts";
import { PERSONA_AVATARS } from "./avatars.generated.ts";
import type { Crew } from "./projects.ts";

/** 单位 → 厂商（编队头像用）；不知道的显示兜帽旅人。由办公室主体提供。 */
export const SquadVendors = createContext<Readonly<Record<string, Vendor>>>({});

/** 7×4 像素小金冠（组长标记）。 */
function Crown() {
  return (
    <svg className="dso-crown" viewBox="0 0 7 4" width="10" height="6" shapeRendering="crispEdges" aria-hidden="true">
      <path d="M0 0h1v1h1v1h1V0h1v2h1V1h1V0h1v4H0z" />
    </svg>
  );
}

/** 一个单位：所用模型的像素头像（与对话界面同一套素材），在跑的全彩亮绿底边，空闲的去色。 */
function Unit({ vendor, on, lead }: { vendor: Vendor; on: boolean; lead: boolean }) {
  return (
    <span className={`dso-unit${on ? " on" : ""}${lead ? " lead" : ""}`}>
      <img src={PERSONA_AVATARS[vendor]} alt="" draggable={false} />
      {lead && <Crown />}
    </span>
  );
}

/** 编队：最多画 max 个头像，多出的标「+N」。组长戴金冠排第一。 */
export function Squad({ crew, lead = false, max = 8 }: { crew: Crew; lead?: boolean; max?: number }) {
  const vendors = useContext(SquadVendors);
  const units =
    crew.units ??
    // 没有单位清单（兜底）：按数字排，组长单独看 leadOn
    Array.from({ length: crew.total }, (_, i) => ({
      id: "",
      lead: lead && i === 0,
      on: lead && i === 0 ? crew.leadOn === true : i - (lead ? 1 : 0) < crew.running - (lead && crew.leadOn ? 1 : 0),
    }));
  const shown = units.slice(0, max);
  return (
    <span className="dso-squad" title={`${crew.running} / ${crew.total} 在干活`}>
      {shown.map((u, i) => (
        <Unit key={u.id || i} vendor={vendors[u.id] ?? "other"} on={u.on} lead={u.lead === true} />
      ))}
      {units.length > max && <small>+{units.length - max}</small>}
    </span>
  );
}

export type SealKind = "busy" | "idle" | "report" | "error" | "waiting";
const SEAL_TITLE: Record<SealKind, string> = { busy: "干活中", idle: "休整中", report: "汇报完毕", error: "出错停下", waiting: "等组员" };

/** 状态徽章：干活中 / 休整（`busy`），或老板办公室的汇报 / 出错 / 等组员（`kind`）。 */
export function Seal({ busy = false, kind, size = 22 }: { busy?: boolean; kind?: SealKind; size?: number }) {
  const k: SealKind = kind ?? (busy ? "busy" : "idle");
  const box = { width: size, height: size };
  const px = size * 0.58;
  if (k === "report" || k === "error" || k === "waiting")
    return (
      <span className={`dso-seal ${k}`} style={box} title={SEAL_TITLE[k]}>
        <svg viewBox="0 0 8 8" width={px} height={px} shapeRendering="crispEdges">
          {k === "report" && <path d="M0 1h8v6H0zM1 2v1h1v1h1v1h2V4h1V3h1V2H6v1H5v1H3V3H2V2z" fillRule="evenodd" />}
          {k === "error" && <path d="M3 0h2v5H3zM3 6h2v2H3z" />}
          {k === "waiting" && <path d="M1 0h6v1H6v2L5 4l1 1v2h1v1H1V7h1V5l1-1-1-1V1H1zM3 1v2l1 1 1-1V1zM3 6v1h2V6L4 5z" fillRule="evenodd" />}
        </svg>
      </span>
    );
  busy = k === "busy";
  return (
    <span className={`dso-seal${busy ? " busy" : ""}`} style={box} title={SEAL_TITLE[k]}>
      {busy ? (
        <svg viewBox="0 0 8 8" width={size * 0.6} height={size * 0.6} shapeRendering="crispEdges">
          <rect className="bar b1" x="0.5" y="2" width="1.6" height="6" />
          <rect className="bar b2" x="3.2" y="2" width="1.6" height="6" />
          <rect className="bar b3" x="5.9" y="2" width="1.6" height="6" />
        </svg>
      ) : (
        <svg viewBox="0 0 8 8" width={size * 0.55} height={size * 0.55} shapeRendering="crispEdges">
          <path d="M3 0h3v1h1v1h-2v1h-1v2h1v1h2v1h-1v1h-3v-1h-1v-1h-1v-4h1v-1h1z" />
        </svg>
      )}
    </span>
  );
}

/** 计数徽章：徽章 + 数字。 */
export function Tally({ busy = false, kind, count, title }: { busy?: boolean; kind?: SealKind; count: number; title: string }) {
  const k: SealKind = kind ?? (busy ? "busy" : "idle");
  return (
    <span className={`dso-tally ${k}${count === 0 ? " zero" : ""}`} title={title}>
      <Seal kind={k} size={18} />
      <b>{count}</b>
    </span>
  );
}
