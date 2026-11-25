/** usage-api 计费拆分：智谱 GLM Coding Plan 按牌价估算 + DeepSeek 峰谷回归 + 裸名桶归一 + Copilot 配额精简。 */

import { describe, expect, it } from "vitest";
import {
  migration,
  normalizeCopilotUsage,
  normalizeOpencodexQuota,
  pricing,
} from "../src/usage-api.ts";

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

describe("美元牌价估算档（claude / gpt / grok / kimi）", () => {
  it("opencodex claude-opus-5-5：输入含缓存写、缓存读、输出分别计价（×7.2）", () => {
    const costs = pricing.costOf(
      "opencodex",
      "opencodex/anthropic/claude-opus-5-5",
      peakTime,
      record({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    );
    // (4 输入 + 5 缓存写 + 0.2 缓存读 + 20 输出) × 7.2，峰谷字段不拆分
    expect(costs.cost).toBeCloseTo(29.2 * 7.2, 10);
    expect(costs.peakCost).toBe(0);
    expect(costs.offCost).toBe(0);
  });

  it("github-copilot claude-sonnet-5：缓存写按 5 分钟档 2.5 美元", () => {
    const costs = pricing.costOf(
      "github-copilot",
      "github-copilot/claude-sonnet-5",
      peakTime,
      record({ cacheWriteTokens: 1_000_000 }),
    );
    expect(costs.cost).toBeCloseTo((2 + 0.5) * 7.2, 10);
  });

  it("openai-codex gpt-6-luna：输入/缓存读/缓存写（30 分钟档）/输出", () => {
    const costs = pricing.costOf(
      "openai-codex",
      "gpt-6-luna",
      peakTime,
      record({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    );
    // (0.1 输入 + 0.125 缓存写 + 0.01 缓存读 + 0.5 输出) × 7.2
    expect(costs.cost).toBeCloseTo(0.735 * 7.2, 10);
  });

  it("grok-4.7 与 grok-4.7--fast（Cursor fast 变体为标准价 2 倍）：缓存写按输入价", () => {
    const usage = record({ inputTokens: 1_000_000, cacheWriteTokens: 1_000_000 });
    const standard = pricing.costOf("opencodex", "opencodex/cursor/grok-4.7", peakTime, usage);
    const fast = pricing.costOf("opencodex", "opencodex/cursor/grok-4.7--fast", peakTime, usage);
    expect(standard.cost).toBeCloseTo((2 + 2) * 7.2, 10);
    expect(fast.cost).toBeCloseTo((4 + 4) * 7.2, 10);
  });

  it("kimi-k3（github-copilot 与 opencodex 两线路同价）：缓存写按输入价", () => {
    const usage = record({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });
    for (const model of [
      "github-copilot/kimi-k3",
      "opencodex/cursor/kimi-k3",
    ]) {
      const provider = model.split("/")[0];
      const costs = pricing.costOf(provider, model, peakTime, usage);
      // (3 输入 + 0.3 缓存读 + 15 输出) × 7.2
      expect(costs.cost).toBeCloseTo(18.3 * 7.2, 10);
    }
  });

  it("牌价表未收录的模型（nvidia 线 deepseek）费用记 0", () => {
    const costs = pricing.costOf(
      "opencodex",
      "opencodex/nvidia/deepseek-ai-deepseek-v4.1-flash",
      peakTime,
      record({ inputTokens: 15_033, outputTokens: 143 }),
    );
    expect(costs.cost).toBe(0);
  });
});

describe("opencodex 配额映射与圆环布局", () => {
  it("openai 报告映射为 5 小时 + 本周双窗口", () => {
    const quota = normalizeOpencodexQuota({
      reports: [
        {
          provider: "openai",
          quota: { fiveHourPercent: 42.6, weeklyPercent: 87, updatedAt: 1 },
        },
      ],
    });
    expect(quota.ok).toBe(true);
    expect(quota.providers[0]?.windows).toEqual([
      { id: "fiveHour", label: "5小时", percent: 42.6, resetAt: 0 },
      { id: "weekly", label: "本周", percent: 87, resetAt: 0 },
    ]);
  });

  it("anthropic 只有周窗口时映射为单窗口，越界百分比截断", () => {
    const quota = normalizeOpencodexQuota({
      reports: [
        { provider: "anthropic", quota: { weeklyPercent: 120, weeklyResetAt: 5 } },
      ],
    });
    expect(quota.providers[0]?.windows).toEqual([
      { id: "weekly", label: "本周", percent: 100, resetAt: 5 },
    ]);
  });

  it("cursor 的 customWindows 落入 extras 小字", () => {
    const quota = normalizeOpencodexQuota({
      reports: [
        {
          provider: "cursor",
          quota: {
            monthlyPercent: 81.9,
            monthlyResetAt: 1796628760000,
            customWindows: [
              { label: "First-party models", percent: 79.86, resetAt: 1 },
              { label: "API usage", percent: 100, resetAt: 1 },
            ],
          },
        },
      ],
    });
    expect(quota.providers[0]?.windows[0]).toMatchObject({ id: "monthly", percent: 81.9 });
    expect(quota.providers[0]?.extras).toHaveLength(2);
    expect(quota.providers[0]?.extras[0]).toMatchObject({ label: "First-party models", percent: 79.86 });
  });

  it("非预期结构安全降级为不可用", () => {
    expect(normalizeOpencodexQuota(null).ok).toBe(false);
    expect(normalizeOpencodexQuota({}).ok).toBe(false);
    expect(
      normalizeOpencodexQuota({ reports: [{ provider: "unknown-provider", quota: {} }] })
        .providers,
    ).toEqual([]);
  });
});

describe("智谱迁到 opencodex 下：计价与配额", () => {
  const usage = record({
    inputTokens: 500_000,
    outputTokens: 100_000,
    cacheReadTokens: 250_000,
  });

  it("opencodex/zai/glm-5.3-flash 剥掉前缀查智谱人民币表，与旧线路同价", () => {
    const migrated = pricing.costOf(
      "opencodex",
      "opencodex/zai/glm-5.3-flash",
      friday(15),
      usage,
    );
    const legacy = pricing.costOf(
      "zai-coding-cn",
      "zai-coding-cn/glm-5.3-flash",
      friday(15),
      usage,
    );
    // 0.25*0.23 + 0.5*0.8 + 0.1*2.8 = 0.7375（元）
    expect(migrated.cost).toBeCloseTo(0.7375, 10);
    expect(migrated.cost).toBe(legacy.cost);
  });

  it("glm-5.4 按积分系数折算的估算价：1.29 / 5.33 / 18.67 元每百万", () => {
    // 智谱高峰是工作日 14-18（北京时间），用 friday(15) 取全额价。
    const only = (over: Parameters<typeof record>[0]) =>
      pricing.costOf("opencodex", "opencodex/zai/glm-5.4", friday(15), record(over))
        .cost;
    expect(only({ cacheReadTokens: 1_000_000 })).toBeCloseTo(1.29, 2);
    expect(only({ inputTokens: 1_000_000 })).toBeCloseTo(5.33, 2);
    expect(only({ outputTokens: 1_000_000 })).toBeCloseTo(18.67, 2);
    // 三项合计 = 逐项之和（没有互相串项）。
    expect(
      only({
        cacheReadTokens: 1_000_000,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBeCloseTo(2 * 1.1 / 1.7 + 8 * 4.6 / 6.9 + 28 * 16 / 24, 10);
  });

  it("峰谷对新键生效：工作日 14-18 高峰全额，其余 5 折", () => {
    const peak = pricing.costOf("opencodex", "opencodex/zai/glm-5.3", friday(15), usage);
    const off = pricing.costOf("opencodex", "opencodex/zai/glm-5.3", friday(20), usage);
    const weekend = pricing.costOf("opencodex", "opencodex/zai/glm-5.3", saturday(15), usage);
    expect(peak.peakCost).toBeGreaterThan(0);
    expect(peak.offCost).toBe(0);
    expect(off.cost).toBeCloseTo(peak.cost * 0.5, 10);
    expect(weekend.offCost).toBeCloseTo(peak.cost * 0.5, 10);
  });

  it("不乘美元汇率：同词元量下与美元档模型量级不同", () => {
    const zai = pricing.costOf("opencodex", "opencodex/zai/glm-5.3", friday(15), usage);
    // 0.25*2 + 0.5*8 + 0.1*28 = 7.3（元）；若误乘 7.2 会得到 52.56。
    expect(zai.cost).toBeCloseTo(7.3, 10);
  });

  it("美元档其他模型行为不变", () => {
    const costs = pricing.costOf(
      "opencodex",
      "opencodex/anthropic/claude-opus-5-5",
      peakTime,
      record({ inputTokens: 1_000_000 }),
    );
    expect(costs.cost).toBeCloseTo(4 * 7.2, 10);
  });

  it("配额 zai 项映射为 5 小时 + 本周双窗口", () => {
    const quota = normalizeOpencodexQuota({
      reports: [
        {
          provider: "zai",
          quota: {
            fiveHourPercent: 23,
            fiveHourResetAt: 1795612357304,
            weeklyPercent: 69,
            weeklyResetAt: 1795968741983,
          },
        },
      ],
    });
    expect(quota.providers[0]?.windows).toEqual([
      { id: "fiveHour", label: "5小时限额", percent: 23, resetAt: 1795612357304 },
      { id: "weekly", label: "本周限额", percent: 69, resetAt: 1795968741983 },
    ]);
  });

  it("配额 zai 项缺失不伪造窗口", () => {
    const quota = normalizeOpencodexQuota({ reports: [{ provider: "zai", quota: {} }] });
    expect(quota.providers).toEqual([]);
  });
});

describe("2026-11-25 对照官方定价页核对后加入的三个模型", () => {
  const USD_CNY = 7.2;
  /** 逐项计价：每项各一百万词元单独算，返回折算后的人民币费用。 */
  const item = (model: string, over: Parameters<typeof record>[0]) =>
    pricing.costOf("opencodex", model, peakTime, record(over)).cost;

  it("claude-sonnet-5-5：2 / 0.10 / 2.50 / 10（与 sonnet-5 是两个模型，缓存读价不同）", () => {
    const model = "opencodex/anthropic/claude-sonnet-5-5";
    expect(item(model, { inputTokens: 1_000_000 })).toBeCloseTo(2 * USD_CNY, 10);
    expect(item(model, { cacheReadTokens: 1_000_000 })).toBeCloseTo(0.1 * USD_CNY, 10);
    expect(item(model, { cacheWriteTokens: 1_000_000 })).toBeCloseTo(2.5 * USD_CNY, 10);
    expect(item(model, { outputTokens: 1_000_000 })).toBeCloseTo(10 * USD_CNY, 10);
    // 回归：这个键此前因表里只有 claude-sonnet-5 而记 0。
    expect(item(model, { inputTokens: 1_000_000 })).toBeGreaterThan(0);
  });

  it("claude-sonnet-5 保持原价，不因新增 5-5 而改变", () => {
    const model = "github-copilot/claude-sonnet-5";
    expect(item(model, { cacheReadTokens: 1_000_000 })).toBeCloseTo(0.2 * USD_CNY, 10);
    expect(item(model, { cacheWriteTokens: 1_000_000 })).toBeCloseTo(2.5 * USD_CNY, 10);
  });

  it("gpt-6.2-sol：2 / 0.10 / 2.50 / 10", () => {
    const model = "opencodex/gpt-6.2-sol";
    expect(item(model, { inputTokens: 1_000_000 })).toBeCloseTo(2 * USD_CNY, 10);
    expect(item(model, { cacheReadTokens: 1_000_000 })).toBeCloseTo(0.1 * USD_CNY, 10);
    expect(item(model, { cacheWriteTokens: 1_000_000 })).toBeCloseTo(2.5 * USD_CNY, 10);
    expect(item(model, { outputTokens: 1_000_000 })).toBeCloseTo(10 * USD_CNY, 10);
  });

  it("gpt-6.2-astra：8 / 0.40 / 10 / 40", () => {
    const model = "opencodex/gpt-6.2-astra";
    expect(item(model, { inputTokens: 1_000_000 })).toBeCloseTo(8 * USD_CNY, 10);
    expect(item(model, { cacheReadTokens: 1_000_000 })).toBeCloseTo(0.4 * USD_CNY, 10);
    expect(item(model, { cacheWriteTokens: 1_000_000 })).toBeCloseTo(10 * USD_CNY, 10);
    expect(item(model, { outputTokens: 1_000_000 })).toBeCloseTo(40 * USD_CNY, 10);
  });

  it("缓存写按「写价 − 输入价」的增量计：缓存写不重复收输入费", () => {
    // 只有缓存写 100 万词元：应只收 10（写价），而不是 8 + 10。
    expect(item("opencodex/gpt-6.2-astra", { cacheWriteTokens: 1_000_000 })).toBeCloseTo(10 * USD_CNY, 10);
  });
});
