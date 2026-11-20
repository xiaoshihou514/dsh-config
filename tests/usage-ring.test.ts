/** 用量面板限额圆环：布局决策（5 小时上半环 / 周·月下半环 / 单窗整环）。 */

import { describe, expect, it } from "vitest";
import {
  ringLayout,
  RING_TOP_ARC,
  RING_BOTTOM_ARC,
  windowTitle,
  type RingWindow,
} from "../src/client/UsageSection.tsx";
import { vi } from "vitest";

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

  it("空窗口与非法百分比返回 null（前端落不可用态）", () => {
    expect(ringLayout([])).toBeNull();
    expect(ringLayout([{ id: "weekly", label: "本周", percent: Number.NaN, resetAt: 0 }])).toBeNull();
  });

  it("双半环使用上下两条弧路径，端点上下分离留出间隙", () => {
    // 上弧越过顶部（sweep=1），下弧越过底部（sweep=0）；端点 y 坐标
    // 43.4 / 56.6 在水平线上下各偏 6.6，两段之间留出间隙。
    expect(RING_TOP_ARC).toMatch(/^M [\d.]+ 43\.4 A 38 38 0 0 1 [\d.]+ 43\.4$/);
    expect(RING_BOTTOM_ARC).toMatch(/^M [\d.]+ 56\.6 A 38 38 0 0 0 [\d.]+ 56\.6$/);
  });

  it("windowTitle 组合指标名、已用/总量与重置时间", () => {
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
    ).toBe("5小时限额：已用 12.35万 / 100.00万（18%） · 重置 1时5分后");
    expect(
      windowTitle({ id: "weekly", label: "本周", percent: 55, resetAt: 0 }),
    ).toBe("本周：已用 55% · 重置时间未知");
    vi.useRealTimers();
  });
});

describe("极坐标命中判定（svg 级悬停）", () => {
  // 与 QuotaRing.svgHover 同口径：viewBox 100，环带 15-55。
  const pick = (
    dxRatio: number,
    dyRatio: number,
    rectWidth: number,
    hasFiveHour: boolean,
  ): string | null => {
    const distance = Math.hypot(dxRatio, dyRatio) * (100 / rectWidth);
    if (distance < 15 || distance > 55) return null;
    const layout = ringLayout(
      hasFiveHour
        ? [
            { id: "fiveHour", label: "5小时限额", percent: 18, resetAt: 0 },
            { id: "weekly", label: "本周", percent: 55, resetAt: 0 },
          ]
        : [{ id: "monthly", label: "本月", percent: 30, resetAt: 0 }],
    );
    if (layout === null) return null;
    const chosen =
      layout.top !== null && dyRatio < 0 ? layout.top : layout.bottom;
    return chosen.id;
  };

  it("环带内上半区命中 5h、下半区命中周", () => {
    expect(pick(0, -25, 72, true)).toBe("fiveHour");
    expect(pick(0, 25, 72, true)).toBe("weekly");
  });

  it("整环（无 5h）上下都命中同一指标", () => {
    expect(pick(0, -25, 72, false)).toBe("monthly");
    expect(pick(0, 25, 72, false)).toBe("monthly");
  });

  it("环心空白与环外不命中（不显示浮窗）", () => {
    expect(pick(0, 0, 72, true)).toBeNull();
    expect(pick(0, 40, 72, true)).toBeNull();
    expect(pick(-34, -34, 72, true)).toBeNull();
  });

  it("按渲染尺寸换算（rect 大小不影响比例判定）", () => {
    // 36px 渲染时环带为 5.4~19.8px，-15px 落在带上限内。
    expect(pick(0, -15, 36, true)).toBe("fiveHour");
    expect(pick(0, -35, 36, true)).toBeNull();
  });
});
