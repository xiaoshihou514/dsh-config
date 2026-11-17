/**
 * 游戏风的势力 / 编队小部件（项目面板、老板办公室共用），与 HUD 同一套语言：渐变方块、底部压边、像素画。
 *
 * - `Squad`：编队——一个像素小人一个单位（组长戴金冠排第一，组员 / 单智能体跟后）；在跑的亮绿、
 *   空闲的灰暗。子代理不占位（它在跑只让派它的单位亮）。数字只在悬停提示里。
 * - `Seal`：状态徽章——干活中是绿色方块里跳动的像素柱，休整是灰色方块里的月牙；老板办公室另有
 *   汇报（金色信封）、出错（红色感叹号）、等组员（蓝色沙漏）。
 * - `Tally`：计数徽章（徽章 + 数字），用于触发按钮与面板抬头。
 */

import type { Crew } from "./projects.ts";

/** 7×8 像素小人（X = 身体，C = 金冠）。 */
const PERSON = ["..CCC..", "..XXX..", "..XXX..", "...X...", ".XXXXX.", "X.XXX.X", "..X.X..", "..X.X.."];

function PixelPerson({ on, lead }: { on: boolean; lead: boolean }) {
  const cells: JSX.Element[] = [];
  PERSON.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      if (ch === "C" && !lead) return;
      const cls = ch === "C" ? "c" : y < 3 ? "h" : "b";
      cells.push(<rect key={`${x},${y}`} x={x} y={y} width="1" height="1" className={cls} />);
    }),
  );
  return (
    <svg className={`dso-px${on ? " on" : ""}${lead ? " lead" : ""}`} viewBox="0 0 7 8" width="12" height="14" shapeRendering="crispEdges">
      {cells}
    </svg>
  );
}

/** 编队：最多画 max 个小人，多出的标「+N」。 */
export function Squad({ crew, lead = false, max = 8 }: { crew: Crew; lead?: boolean; max?: number }) {
  const shown = Math.max(1, Math.min(crew.total, max));
  // 亮哪些：团队里组长单独看 leadOn，组员按在跑数从前往后亮
  const people: { on: boolean; lead: boolean }[] = [];
  let rest = crew.running - (lead && crew.leadOn === true ? 1 : 0);
  for (let i = 0; i < shown; i += 1) {
    const isLead = lead && i === 0;
    const on = isLead ? crew.leadOn === true : rest > 0;
    if (!isLead && on) rest -= 1;
    people.push({ on, lead: isLead });
  }
  return (
    <span className="dso-squad" title={`${crew.running} / ${crew.total} 在干活`}>
      {people.map((p, i) => (
        <PixelPerson key={i} on={p.on} lead={p.lead} />
      ))}
      {crew.total > max && <small>+{crew.total - max}</small>}
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
