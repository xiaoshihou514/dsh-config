/** 用量面板限额圆环：布局决策（5 小时上半环 / 周·月下半环 / 单窗整环）。 */

import { describe, expect, it } from "vitest";
import {
  ringLayout,
  RING_TOP_ARC,
  RING_BOTTOM_ARC,
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

  it("空窗口与非法百分比返回 null（前端落不可用态）", () => {
    expect(ringLayout([])).toBeNull();
    expect(ringLayout([{ id: "weekly", label: "本周", percent: Number.NaN, resetAt: 0 }])).toBeNull();
  });

  it("双半环使用上下两条弧路径", () => {
    // 上弧越过顶部（sweep=1），下弧越过底部（sweep=0），起点都在左中。
    expect(RING_TOP_ARC).toMatch(/^M \d+ 50 A 38 38 0 0 1 \d+ 50$/);
    expect(RING_BOTTOM_ARC).toMatch(/^M \d+ 50 A 38 38 0 0 0 \d+ 50$/);
  });
});
