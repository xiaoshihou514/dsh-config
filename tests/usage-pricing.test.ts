/** usage-api 计费拆分：智谱 GLM Coding Plan 按牌价估算 + DeepSeek 峰谷回归 + 裸名桶归一 + Copilot 配额精简。 */

import { describe, expect, it } from "vitest";
import { migration, normalizeCopilotUsage, pricing } from "../src/usage-api.ts";

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

/** 北京时间时间戳助手：周五 2026-10-16（工作日）。 */
const friday = (hour: number) => Date.UTC(2026, 9, 16) + (hour - 8) * 3_600_000;
const saturday = (hour: number) => Date.UTC(2026, 9, 17) + (hour - 8) * 3_600_000;
/** DeepSeek 峰谷（每天 9-12、14-18）：周五 10:00 高峰 / 20:00 闲时。 */
const peakTime = friday(10);
const offTime = friday(20);

describe("zai-coding-cn 按智谱牌价估算", () => {
  it("glm-5.3-flash 按统一牌价计费（0.23/0.8/2.8 元每百万）", () => {
    const costs = pricing.costOf(
      "zai-coding-cn",
      "zai-coding-cn/glm-5.3-flash",
      friday(15),
      record({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
      }),
    );
    // 0.23 + 0.8 + 2.8 = 3.83
    expect(costs.cost).toBeCloseTo(3.83, 10);
  });

  it("工作日 14-18 为高峰（积分全额），其余闲时（积分 5 折）", () => {
    const usage = record({
      inputTokens: 500_000,
      outputTokens: 100_000,
      cacheReadTokens: 250_000,
    });
    const peak = pricing.costOf(
      "zai-coding-cn",
      "zai-coding-cn/glm-5.3-flash",
      friday(15),
      usage,
    );
    const off = pricing.costOf(
      "zai-coding-cn",
      "zai-coding-cn/glm-5.3-flash",
      friday(20),
      usage,
    );
    // 0.25*0.23 + 0.5*0.8 + 0.1*2.8 = 0.0575 + 0.4 + 0.28
    expect(peak.cost).toBeCloseTo(0.7375, 10);
    expect(peak.peakCost).toBeCloseTo(0.7375, 10);
    expect(peak.offCost).toBe(0);
    expect(off.cost).toBeCloseTo(0.7375 / 2, 10);
    expect(off.peakCost).toBe(0);
    expect(off.offCost).toBeCloseTo(0.7375 / 2, 10);
  });

  it("周末全天为非高峰（5 折）", () => {
    const usage = record({ inputTokens: 1_000_000 });
    const saturdayNoon = saturday(12);
    const off = pricing.costOf(
      "zai-coding-cn",
      "zai-coding-cn/glm-5.3-flash",
      saturdayNoon,
      usage,
    );
    expect(off.cost).toBeCloseTo(0.4, 10);
    expect(off.offCost).toBeCloseTo(0.4, 10);
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

describe("Copilot 配额响应精简", () => {
  it("提取套餐、SKU、重置日与三个配额窗口（对齐 copilot_internal/user 真实形态）", () => {
    const usage = normalizeCopilotUsage({
      login: "octocat",
      copilot_plan: "individual",
      access_type_sku: "free_engaged_oss_quota",
      quota_reset_date: "2026-11-01",
      quota_snapshots: {
        chat: {
          percent_remaining: 100.0,
          unlimited: true,
          credits_used: 0,
          remaining: 0,
          entitlement: 0,
          overage_permitted: false,
        },
        completions: {
          percent_remaining: 100.0,
          unlimited: true,
          credits_used: 0,
          remaining: 0,
          entitlement: 0,
          overage_permitted: false,
        },
        premium_interactions: {
          percent_remaining: 0.0,
          quota_remaining: -7.7,
          unlimited: false,
          credits_used: 1507,
          remaining: -8,
          entitlement: 1500,
          overage_permitted: false,
        },
      },
    });
    expect(usage).toMatchObject({
      ok: true,
      plan: "individual",
      sku: "free_engaged_oss_quota",
      resetDate: "2026-11-01",
    });
    expect(usage.quotas).toHaveLength(3);
    expect(usage.quotas?.[0]).toMatchObject({
      id: "premium_interactions",
      entitlement: 1500,
      remaining: -8,
      used: 1507,
      percentRemaining: 0,
      unlimited: false,
    });
    expect(usage.quotas?.[1]).toMatchObject({ id: "chat", unlimited: true });
    expect(usage.quotas?.[2]).toMatchObject({
      id: "completions",
      unlimited: true,
    });
  });

  it("非法形态与非有限数值安全降级", () => {
    expect(normalizeCopilotUsage(null)).toMatchObject({ ok: false });
    expect(normalizeCopilotUsage("nope")).toMatchObject({ ok: false });
    const usage = normalizeCopilotUsage({
      quota_snapshots: {
        premium_interactions: {
          entitlement: Number.NaN,
          remaining: "bad",
          credits_used: 3,
          percent_remaining: 250,
          unlimited: false,
        },
      },
    });
    expect(usage.ok).toBe(true);
    expect(usage.quotas?.[0]).toMatchObject({
      entitlement: 0,
      remaining: 0,
      used: 3,
      percentRemaining: 100,
    });
  });
});
