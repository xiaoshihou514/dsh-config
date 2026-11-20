/** 用量面板限额圆环：布局决策、悬停命中、提示文案、智谱窗口映射与峰谷。 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ringHit,
  ringLayout,
  RING_BOTTOM_ARC,
  RING_HIT_INNER,
  RING_HIT_OUTER,
  RING_SIZE,
  RING_TOP_ARC,
  windowTitle,
  zaiPeakStyle,
  zaiWindowKind,
  type RingWindow,
} from "../src/client/UsageSection.tsx";

const window = (over: Partial<RingWindow>): RingWindow => ({
  id: "weekly",
  label: "本周",
  percent: 0,
  resetAt: 0,
  ...over,
});

describe("ringLayout 布局决策", () => {
  it("有 5 小时窗口时上下双半环", () => {
    const layout = ringLayout([
      window({ id: "fiveHour", label: "5小时", percent: 42 }),
      window({ id: "weekly", label: "本周", percent: 87 }),
    ]);
    expect(layout?.fullCircle).toBe(false);
    expect(layout?.top?.id).toBe("fiveHour");
    expect(layout?.bottom.id).toBe("weekly");
  });

  it("只有周/月窗口时整环展示", () => {
    const layout = ringLayout([window({ id: "monthly", label: "本月", percent: 30 })]);
    expect(layout?.fullCircle).toBe(true);
    expect(layout?.top).toBeNull();
    expect(layout?.bottom.id).toBe("monthly");
  });

  it("只有 5 小时窗口时也整环展示", () => {
    const layout = ringLayout([window({ id: "fiveHour", percent: 10 })]);
    expect(layout?.fullCircle).toBe(true);
    expect(layout?.bottom.id).toBe("fiveHour");
  });

  it("空窗口与非法百分比返回 null（前端落灰环占位）", () => {
    expect(ringLayout([])).toBeNull();
    expect(ringLayout([{ id: "weekly", label: "本周", percent: Number.NaN, resetAt: 0 }])).toBeNull();
  });
});

describe("双半环间隙", () => {
  const endpoint = (arc: string): { x: number; y: number } => {
    const [, x, y] = /^M ([\d.]+) ([\d.]+) /.exec(arc)!;
    return { x: Number(x), y: Number(y) };
  };

  it("端点落在半径 38 的圆上，上弧越过顶部、下弧越过底部", () => {
    for (const arc of [RING_TOP_ARC, RING_BOTTOM_ARC]) {
      const { x, y } = endpoint(arc);
      expect(Math.hypot(x - 50, y - 50)).toBeCloseTo(38, 1);
    }
    expect(RING_TOP_ARC).toMatch(/A 38 38 0 0 1 /);
    expect(RING_BOTTOM_ARC).toMatch(/A 38 38 0 0 0 /);
  });

  it("扣掉圆头线帽（各 4.5）后 72px 渲染仍有 ≥4px 的净间隙", () => {
    const gap = endpoint(RING_BOTTOM_ARC).y - endpoint(RING_TOP_ARC).y - 9;
    expect(gap * (RING_SIZE / 100)).toBeGreaterThanOrEqual(4);
  });
});

describe("ringHit 悬停命中（真实组件用的同一函数）", () => {
  const R = (38 / 100) * RING_SIZE; // 环带中线半径（px）

  it("环带中部：上半区命中 5h、下半区命中周", () => {
    expect(ringHit(0, -R, RING_SIZE, true)).toBe("top");
    expect(ringHit(0, R, RING_SIZE, true)).toBe("bottom");
    // 左下 135°：多为空底轨（没画进度弧）也要命中。
    expect(ringHit(-R * Math.SQRT1_2, R * Math.SQRT1_2, RING_SIZE, true)).toBe("bottom");
  });

  it("上下分界附近按 dy 符号切换，没有不命中的死区", () => {
    expect(ringHit(-R, -1, RING_SIZE, true)).toBe("top");
    expect(ringHit(-R, 1, RING_SIZE, true)).toBe("bottom");
    expect(ringHit(-R, 0, RING_SIZE, true)).toBe("bottom");
  });

  it("整环（无 5h）上下都命中同一指标", () => {
    expect(ringHit(0, -R, RING_SIZE, false)).toBe("bottom");
    expect(ringHit(0, R, RING_SIZE, false)).toBe("bottom");
  });

  it("环心数字区与环外不命中", () => {
    expect(ringHit(0, 0, RING_SIZE, true)).toBeNull();
    expect(ringHit(10, 0, RING_SIZE, true)).toBeNull();
    expect(ringHit(RING_SIZE / 2, -RING_SIZE / 2, RING_SIZE, true)).toBeNull();
  });

  it("命中带覆盖整条描边（半径 33.5~42.5）并留出容差", () => {
    expect(RING_HIT_INNER).toBeLessThan(33.5);
    expect(RING_HIT_OUTER).toBeGreaterThan(42.5);
  });

  it("按渲染尺寸换算", () => {
    expect(ringHit(0, -14, 36, true)).toBe("top");
    expect(ringHit(0, -35, 36, true)).toBeNull();
  });
});

describe("windowTitle 悬停文案", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("逐行：指标名 / 已用与总量 / 重置时间", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
    expect(
      windowTitle({
        id: "fiveHour",
        label: "5小时限额",
        percent: 18,
        resetAt: Date.now() + 65 * 60_000,
        used: 123_456,
        total: 1_000_000,
      }),
    ).toBe("5小时限额\n已用 12.35万 / 100.00万（18%）\n1时5分后重置");
    expect(windowTitle({ id: "weekly", label: "本周", percent: 55, resetAt: 0 })).toBe(
      "本周\n已用 55%\n重置时间未知",
    );
  });

  it("附加说明另起一行；占位窗口说明未下发", () => {
    expect(
      windowTitle({ id: "monthly", label: "本月限额", percent: 9, resetAt: 0, extraNote: "Auto：已用 12%" }),
    ).toBe("本月限额\n已用 9%\n重置时间未知\nAuto：已用 12%");
    expect(
      windowTitle({ id: "fiveHour", label: "5小时限额", percent: 0, resetAt: 0, missing: true }),
    ).toBe("5小时限额\n接口未下发该窗口（按 0% 占位）");
  });
});

describe("智谱窗口映射与峰谷", () => {
  it("5时→上半环、周/2w→下半环", () => {
    expect(zaiWindowKind("5时")).toEqual({ id: "fiveHour", label: "5小时限额" });
    expect(zaiWindowKind("周")).toEqual({ id: "weekly", label: "本周限额" });
    expect(zaiWindowKind("2w").id).toBe("weekly");
  });

  it("峰谷用中心数字颜色区分（不用符号），说明进悬停", () => {
    const peak = zaiPeakStyle(true);
    const off = zaiPeakStyle(false);
    expect(peak.color).not.toBe(off.color);
    expect(peak.color).toMatch(/^var\(--dsw-/);
    expect(off.color).toMatch(/^var\(--dsw-/);
    expect(`${peak.note}${off.note}`).not.toMatch(/[▲▽△▼]/);
  });
});
