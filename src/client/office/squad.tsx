/**
 * 游戏风的势力 / 编队小部件（项目面板、老板办公室共用），与 HUD 同一套语言：渐变方块、底部压边、像素画。
 *
 * - `Squad`：编队——一个像素小人一个单位（组长戴金冠排第一，组员 / 单智能体跟后）；在跑的亮绿、
 *   空闲的灰暗。子代理不占位（它在跑只让派它的单位亮）。数字只在悬停提示里。
 * - `Seal`：状态徽章——干活中是绿色方块里跳动的像素柱，休整是灰色方块里的月牙。
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

/** 状态徽章：干活中 / 休整。 */
export function Seal({ busy, size = 22 }: { busy: boolean; size?: number }) {
  return (
    <span className={`dso-seal${busy ? " busy" : ""}`} style={{ width: size, height: size }} title={busy ? "干活中" : "休整中"}>
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
export function Tally({ busy, count, title }: { busy: boolean; count: number; title: string }) {
  return (
    <span className={`dso-tally${busy ? " busy" : ""}`} title={title}>
      <Seal busy={busy} size={18} />
      <b>{count}</b>
    </span>
  );
}
