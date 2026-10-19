/** usage-api 计费拆分：智谱 GLM Coding Plan 按牌价估算 + DeepSeek 峰谷回归 + 裸名桶归一。 */

import { describe, expect, it } from "vitest";
import { migration, pricing } from "../src/usage-api.ts";

const record = (over: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}) => ({
  inputTokens: over.inputTokens ?? 0,
  outputTokens: over.outputTokens ?? 0,
  cacheReadTokens: over.cacheReadTokens,
  cacheWriteTokens: over.cacheWriteTokens,
});

/** 北京时间当天高峰段（10:00）与闲时段（20:00）的时间戳。 */
const peakTime = Date.UTC(2026, 9, 17) + (10 - 8) * 3_600_000;
const offTime = Date.UTC(2026, 9, 17) + (20 - 8) * 3_600_000;

describe("zai-coding-cn 按智谱牌价估算", () => {
  it("glm-5.3-flash 按统一牌价计费（0.23/0.8/2.8 元每百万）", () => {
    const costs = pricing.costOf(
      "zai-coding-cn",
      "zai-coding-cn/glm-5.3-flash",
      peakTime,
      record({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
      }),
    );
    // 0.23 + 0.8 + 2.8 = 3.83
    expect(costs.cost).toBeCloseTo(3.83, 10);
  });

  it("无峰谷差价：高峰与闲时同价，峰/闲拆分按发生时段归侧", () => {
    const usage = record({
      inputTokens: 500_000,
      outputTokens: 100_000,
      cacheReadTokens: 250_000,
    });
    const peak = pricing.costOf(
      "zai-coding-cn",
      "zai-coding-cn/glm-5.3-flash",
      peakTime,
      usage,
    );
    const off = pricing.costOf(
      "zai-coding-cn",
      "zai-coding-cn/glm-5.3-flash",
      offTime,
      usage,
    );
    // 0.25*0.23 + 0.5*0.8 + 0.1*2.8 = 0.0575 + 0.4 + 0.28
    expect(peak.cost).toBeCloseTo(0.7375, 10);
    expect(off.cost).toBeCloseTo(0.7375, 10);
    expect(peak.peakCost).toBeCloseTo(0.7375, 10);
    expect(peak.offCost).toBe(0);
    expect(off.peakCost).toBe(0);
    expect(off.offCost).toBeCloseTo(0.7375, 10);
  });

  it("未知 GLM 模型记 0（不猜价）", () => {
    const costs = pricing.costOf(
      "zai-coding-cn",
      "zai-coding-cn/glm-99-unknown",
      peakTime,
      record({ inputTokens: 1_000_000 }),
    );
    expect(costs).toEqual({ cost: 0, peakCost: 0, offCost: 0 });
  });
});

describe("原有计费回归", () => {
  it("deepseek-v4-flash 闲时半价、高峰原价", () => {
    const usage = record({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
    });
    const peak = pricing.costOf("deepseek-official", "deepseek-v4-flash", peakTime, usage);
    const off = pricing.costOf("deepseek-official", "deepseek-v4-flash", offTime, usage);
    expect(peak.cost).toBeCloseTo(12, 10); // 3 + 9
    expect(off.cost).toBeCloseTo(6, 10);
  });

  it("deepseek-flash（0.2.0 新名）按同一 flash 档峰谷价计", () => {
    const usage = record({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
    });
    const peak = pricing.costOf("deepseek-official", "deepseek-flash", peakTime, usage);
    const off = pricing.costOf("deepseek-official", "deepseek-flash", offTime, usage);
    expect(peak.cost).toBeCloseTo(12, 10);
    expect(off.cost).toBeCloseTo(6, 10);
  });

  it("其余订阅档恒为 0", () => {
    const costs = pricing.costOf(
      "opencode-free",
      "opencode-free/some-free-model",
      peakTime,
      record({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    );
    expect(costs).toEqual({ cost: 0, peakCost: 0, offCost: 0 });
  });
});

describe("历史裸名桶归一", () => {
  const emptyCell = () => ({
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    peakCost: 0,
    offCost: 0,
  });
  const cell = (calls: number) => ({ ...emptyCell(), calls });

  it("裸名并入复合名桶，cells 键同步归一", () => {
    const day = {
      total: emptyCell(),
      byProject: {},
      byModel: {
        "mimo-v2.5-free": cell(14),
        "opencode-free/mimo-v2.5-free": cell(17),
      },
      cells: {
        "a\u0000mimo-v2.5-free": cell(10),
        "b\u0000mimo-v2.5-free": cell(4),
        "a\u0000opencode-free/mimo-v2.5-free": cell(17),
      },
    };
    migration.normalizeModelBuckets(day);
    expect(Object.keys(day.byModel)).toEqual(["opencode-free/mimo-v2.5-free"]);
    expect(day.byModel["opencode-free/mimo-v2.5-free"].calls).toBe(31);
    expect(day.cells["a\u0000opencode-free/mimo-v2.5-free"].calls).toBe(27);
    expect(day.cells["b\u0000opencode-free/mimo-v2.5-free"].calls).toBe(4);
    expect(Object.keys(day.cells)).toHaveLength(2);
  });

  it("幂等：无裸名时归一不做任何事", () => {
    const day = {
      total: emptyCell(),
      byProject: {},
      byModel: { "zai-coding-cn/glm-5.3": cell(5) },
      cells: { "a\u0000zai-coding-cn/glm-5.3": cell(5) },
    };
    migration.normalizeModelBuckets(day);
    expect(Object.keys(day.byModel)).toEqual(["zai-coding-cn/glm-5.3"]);
    expect(day.byModel["zai-coding-cn/glm-5.3"].calls).toBe(5);
  });
});
