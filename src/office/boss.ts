/**
 * 老板办公室：组长什么时候来向你汇报（宿主与浏览器共用的纯判定）。
 *
 * - waiting（等待组员进展）：派完活在等——有组员在跑，组长自己没在干活（没有未结束的步骤，
 *   或正卡在等组员的工具上，如 wait_agent）。
 * - report（汇报完毕）/ error（出错停下）：组长这一轮已结束、整个团队都停下了，按最近一轮是否成功区分。
 * - 其余（组长正在干活、或还没开过一轮）不来老板办公室。
 */

import type { OfficeTurnEnd } from "./types.ts";

export type BossState = "report" | "error" | "waiting";

export interface BossFacts {
  /** 组长有未结束的步骤（在跑）。 */
  readonly leadRunning: boolean;
  /** 组长当前动作是「等待组员」。 */
  readonly leadWaiting: boolean;
  /** 组长最近一轮的结束（之后又开了新一轮则没有）。 */
  readonly lastTurn?: OfficeTurnEnd | undefined;
  /** 有组员在跑。 */
  readonly membersRunning: boolean;
}

export function bossStateOf(facts: BossFacts): BossState | null {
  if (facts.membersRunning && (!facts.leadRunning || facts.leadWaiting)) return "waiting";
  if (facts.leadRunning || facts.membersRunning) return null;
  if (facts.lastTurn === undefined) return null;
  return facts.lastTurn.ok ? "report" : "error";
}

export const BOSS_LABEL: Record<BossState, string> = {
  report: "汇报完毕，等你回复",
  error: "这一轮出错停下了",
  waiting: "派完活，等组员进展",
};
