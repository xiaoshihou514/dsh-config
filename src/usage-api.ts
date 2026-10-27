/**
 * 词元用量记账与同源读 API。
 *
 * v2 数据结构：历史数据按「自然日 ×（项目 × 模型）」**提前聚合**持久化
 * （费用含峰谷拆分），只有**今天**保留逐条明细；跨天后旧明细自然折叠进
 * 聚合。读 API 只返回聚合 + 今日明细，响应体比 v1 全量 records 小一两个
 * 数量级；写盘走防抖批量合并，不再每条全量重写。
 *
 * 支持 provider：deepseek-official（官方峰谷计费）；zai-coding-cn（GLM
 * Coding Plan 包月套餐，按智谱国内站 API 牌价估算费用（非高峰 5 折积分）；其余
 * 订阅档（OpenCode Free、Codex、GitHub Copilot 等）费用恒为 0，只统计词元量。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { copilotAuthFile } from "./copilot-auth.ts";

export const name = "dsh-config-usage-api";
export const inject = ["sessions", "webServer"];

const ROUTE = "/dsh-config/usage";
const PROVIDER_ROUTE = "/dsh-config/provider-status";
const HEADER = "x-dsh-config";
const HEADER_VALUE = "usage-calendar";

const OFFICIAL_PROVIDER = "deepseek-official";
/** 订阅档：不按 token 计费，只记账词元量。 */
const SUBSCRIPTION_PROVIDERS = new Set([
  "opencode-free",
  "openai-codex",
  "github-copilot",
  "kimi-coding",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
  "opencode-go",
]);

/**
 * 计价订阅档：包月套餐，仍只记账词元量，但按供应商 API 牌价**估算**费用
 * （供「如果按量付费要花多少」参考）。目前仅智谱 GLM Coding Plan（国内站）。
 */
const PRICED_PROVIDERS = new Set(["zai-coding-cn"]);

/**
 * 智谱国内站（bigmodel.cn）API 牌价（元 / 百万 tokens）：缓存命中 / 未命中输入 / 输出。
 * 来源：docs.bigmodel.cn「API 定价」页与 Coding Plan 用量说明（非高峰积分
 *  5 折抵扣）。分档模型
 * （按输入长度分两档）按低档计。缓存存储当前限时免费，不计。
 */
const ZAI_PRICE = {
  "glm-5.3-flash": { hit: 0.23, miss: 0.8, output: 2.8 },
  "glm-5.3-flashx": { hit: 0.57, miss: 2, output: 7 },
  "glm-5.3": { hit: 2, miss: 8, output: 28 },
  "glm-5.2": { hit: 2, miss: 8, output: 28 },
  "glm-5.1": { hit: 1.3, miss: 6, output: 24 },
  "glm-5-turbo": { hit: 1.2, miss: 5, output: 22 },
  "glm-5": { hit: 1, miss: 4, output: 18 },
} as const;

/** 智谱峰谷：周一至周五 14:00-18:00（UTC+8）高峰，其余（含周末）闲时。
 *  非高峰时段套餐积分按 50% 抵扣（docs.bigmodel.cn Coding Plan 用量说明）。 */
function isZaiPeak(time: number): boolean {
  const beijing = new Date(time + 8 * 3_600_000);
  const day = beijing.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = beijing.getUTCHours();
  return hour >= 14 && hour < 18;
}

/** 官方模型单价（元 / 百万 tokens）：高峰 / 闲时。 */
const PEAK_PRICE = {
  flash: { hit: 0.1, miss: 3, output: 9 },
  pro: { hit: 0.3, miss: 9, output: 27 },
} as const;
/** 闲时为高峰半价。 */
const OFF_RATIO = 0.5;

/** 高峰时段按北京时间（UTC+8，无夏令时）：9:00-12:00、14:00-18:00。 */
function isPeak(time: number): boolean {
  const hour = new Date(time + 8 * 3_600_000).getUTCHours();
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/** 单条记录的费用拆分（元）；订阅档恒为 0（不按 token 计费）。 */
function costOf(
  provider: string,
  model: string,
  at: number,
  record: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
): { cost: number; peakCost: number; offCost: number } {
  if (SUBSCRIPTION_PROVIDERS.has(provider))
    return { cost: 0, peakCost: 0, offCost: 0 };
  const cacheRead = record.cacheReadTokens ?? 0;
  const cacheWrite = record.cacheWriteTokens ?? 0;
  // 计价订阅档（智谱 GLM Coding Plan）：按 API 牌价估算。非高峰时段积分
  // 5 折抵扣（费用随之减半），峰/闲拆分反映真实消耗差。
  if (PRICED_PROVIDERS.has(provider)) {
    const bare = model.slice(provider.length + 1).toLowerCase();
    const price = ZAI_PRICE[bare as keyof typeof ZAI_PRICE];
    if (price === undefined) return { cost: 0, peakCost: 0, offCost: 0 };
    // 基础积分折算；非高峰时段积分按 50% 抵扣（费用随之减半）。
    const base =
      (cacheRead * price.hit +
        (record.inputTokens + cacheWrite) * price.miss +
        record.outputTokens * price.output) /
      1_000_000;
    return isZaiPeak(at)
      ? { cost: base, peakCost: base, offCost: 0 }
      : { cost: base * 0.5, peakCost: 0, offCost: base * 0.5 };
  }
  // 0.2.0 起官方 flash 模型更名为 deepseek-flash（原 deepseek-v4-flash），
  // 两者按同一 flash 档峰谷价计。
  const price =
    model === "deepseek-v4-pro"
      ? PEAK_PRICE.pro
      : model === "deepseek-v4-flash" || model === "deepseek-flash"
        ? PEAK_PRICE.flash
        : undefined;
  if (price === undefined) return { cost: 0, peakCost: 0, offCost: 0 };
  const peak =
    (cacheRead * price.hit +
      (record.inputTokens + cacheWrite) * price.miss +
      record.outputTokens * price.output) /
    1_000_000;
  const off = peak * OFF_RATIO;
  const tier = isPeak(at) ? "peak" : "off";
  const cost = tier === "peak" ? peak : off;
  return {
    cost,
    peakCost: tier === "peak" ? cost : 0,
    offCost: tier === "off" ? cost : 0,
  };
}

interface UsageRecord {
  id: string;
  at: number;
  project: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  peakCost: number;
  offCost: number;
}

/** 一天内一个（项目 × 模型）组合的聚合。 */
interface CellSummary {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  peakCost: number;
  offCost: number;
}

/** 一天的聚合：总量 + 按项目 / 按模型 / 按「项目×模型」分桶（供筛选）。 */
interface DaySummary {
  total: CellSummary;
  byProject: Record<string, CellSummary>;
  byModel: Record<string, CellSummary>;
  cells: Record<string, CellSummary>;
}

interface UsageFile {
  version: 2;
  days: Record<string, DaySummary>;
  /** 仅当前自然日的逐条明细；跨天后折叠进 days。 */
  today: UsageRecord[];
}

function emptyCell(): CellSummary {
  return {
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    peakCost: 0,
    offCost: 0,
  };
}

function addCell(target: CellSummary, source: CellSummary): void {
  target.calls += source.calls;
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.cost += source.cost;
  target.peakCost += source.peakCost;
  target.offCost += source.offCost;
}

function cellOf(record: UsageRecord): CellSummary {
  return {
    calls: 1,
    input: record.inputTokens,
    output: record.outputTokens,
    cacheRead: record.cacheReadTokens,
    cacheWrite: record.cacheWriteTokens,
    cost: record.cost,
    peakCost: record.peakCost,
    offCost: record.offCost,
  };
}

function dayKeyOf(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dataPath(): string {
  return join(
    process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"),
    "dsh-config",
    "usage.json",
  );
}

function modelOf(provider: string, model: string): string | undefined {
  if (provider === OFFICIAL_PROVIDER) {
    // 0.2.0 起官方 flash 模型更名为 deepseek-flash；旧名兼容历史。
    return model === "deepseek-v4-pro" ||
      model === "deepseek-v4-flash" ||
      model === "deepseek-flash"
      ? model
      : undefined;
  }
  // 计价订阅档与免费订阅档一样以「provider/model」复合名入账（筛选标签、
  // 聚合桶保持同一形态，历史数据不分裂）。
  if (
    (SUBSCRIPTION_PROVIDERS.has(provider) || PRICED_PROVIDERS.has(provider)) &&
    model !== ""
  )
    return `${provider}/${model}`;
  return undefined;
}

function projectName(cwd: string | undefined): string {
  return cwd === undefined ? "未指定项目" : basename(cwd) || cwd;
}

function isRecord(value: unknown): value is UsageRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const record = value as Partial<UsageRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.at === "number" &&
    typeof record.project === "string" &&
    typeof record.model === "string" &&
    [
      record.inputTokens,
      record.outputTokens,
      record.cacheReadTokens,
      record.cacheWriteTokens,
      record.cost,
      record.peakCost,
      record.offCost,
    ].every(
      (count) =>
        typeof count === "number" && Number.isFinite(count) && count >= 0,
    )
  );
}

function isCell(value: unknown): value is CellSummary {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const cell = value as Partial<CellSummary>;
  return [
    "calls",
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "cost",
    "peakCost",
    "offCost",
  ].every((key) => {
    const n = (cell as Record<string, unknown>)[key];
    return typeof n === "number" && Number.isFinite(n) && n >= 0;
  });
}

function emptyFile(): UsageFile {
  return { version: 2, days: {}, today: [] };
}

/** 把一条记录折叠进聚合（迁移或实时记账共用）。 */
function foldRecord(
  file: UsageFile,
  record: UsageRecord,
  todayKey: string,
): void {
  const key = dayKeyOf(record.at);
  const day = (file.days[key] ??= {
    total: emptyCell(),
    byProject: {},
    byModel: {},
    cells: {},
  });
  const cell = cellOf(record);
  addCell(day.total, cell);
  const projectBucket = (day.byProject[record.project] ??= emptyCell());
  addCell(projectBucket, cell);
  const modelBucket = (day.byModel[record.model] ??= emptyCell());
  addCell(modelBucket, cell);
  const cellKey = `${record.project}\u0000${record.model}`;
  const bucket = (day.cells[cellKey] ??= emptyCell());
  addCell(bucket, cell);
  if (key === todayKey) file.today.push(record);
}

/** 历史裸名模型桶 → 现行复合名键（早期订阅模型未加 provider 前缀时代入账的）。 */
const LEGACY_MODEL_KEYS: Record<string, string> = {
  "mimo-v2.5-free": "opencode-free/mimo-v2.5-free",
  "x-preview-f-free": "opencode-free/x-preview-f-free",
  "gpt-5.6-luna": "openai-codex/gpt-5.6-luna",
  "gpt-5.3-codex-spark": "openai-codex/gpt-5.3-codex-spark",
};

/** 把一天的裸名模型桶并入复合名桶（幂等：无裸名时什么都不做）。 */
function normalizeModelBuckets(day: DaySummary): void {
  for (const [bare, full] of Object.entries(LEGACY_MODEL_KEYS)) {
    const cell = day.byModel[bare];
    if (cell === undefined) continue;
    const target = (day.byModel[full] ??= emptyCell());
    addCell(target, cell);
    delete day.byModel[bare];
    for (const key of Object.keys(day.cells)) {
      const index = key.indexOf("\u0000");
      if (index === -1 || key.slice(index + 1) !== bare) continue;
      const source = day.cells[key];
      if (source === undefined) continue;
      const newKey = `${key.slice(0, index)}\u0000${full}`;
      const targetCell = (day.cells[newKey] ??= emptyCell());
      addCell(targetCell, source);
      delete day.cells[key];
    }
  }
}

async function load(path: string): Promise<UsageFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return emptyFile();
    const candidate = parsed as Partial<UsageFile> & { records?: unknown };
    // v1 → v2 迁移：全量 records 折叠为按天聚合，今天的保留明细。
    if (Array.isArray(candidate.records)) {
      const file = emptyFile();
      const todayKey = dayKeyOf(Date.now());
      for (const entry of candidate.records) {
        if (!isRecord(entry)) continue;
        // v1 记录没有费用字段：按 provider 补算。v1 只记 deepseek-official。
        const costs = costOf(OFFICIAL_PROVIDER, entry.model, entry.at, entry);
        foldRecord(file, { ...entry, ...costs }, todayKey);
      }
      return file;
    }
    if (candidate.version === 2) {
      const days: Record<string, DaySummary> = {};
      for (const [key, day] of Object.entries(candidate.days ?? {})) {
        if (day === null || typeof day !== "object" || !isCell(day.total))
          continue;
        const buckets = (
          field: "byProject" | "byModel" | "cells",
        ): Record<string, CellSummary> => {
          const out: Record<string, CellSummary> = {};
          for (const [bucketKey, cell] of Object.entries(
            (day as unknown as Record<string, unknown>)[field] ?? {},
          )) {
            if (isCell(cell)) out[bucketKey] = cell;
          }
          return out;
        };
        days[key] = {
          total: day.total,
          byProject: buckets("byProject"),
          byModel: buckets("byModel"),
          cells: buckets("cells"),
        };
        normalizeModelBuckets(days[key]);
      }
      return {
        version: 2,
        days,
        today: Array.isArray(candidate.today)
          ? candidate.today.filter(isRecord)
          : [],
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return emptyFile();
}

async function save(path: string, value: UsageFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

/** 计费拆分（测试出口）：单条记录按供应商价目表算费用。 */
export const pricing = { costOf };

/** 裸名模型桶归一（测试出口）。 */
export const migration = { normalizeModelBuckets };

// ===== 供应商状态代理（DeepSeek 余额 / 智谱套餐配额 / Copilot 配额）=====

/** 单条余额：币种与金额。 */
interface BalanceItem {
  currency: string;
  total: number;
  granted: number;
  toppedUp: number;
}

interface DeepseekBalance {
  ok: boolean;
  /** unconfigured（未配置密钥）/ HTTP n / network */
  reason?: string;
  isAvailable?: boolean;
  balances?: BalanceItem[];
}

interface QuotaWindow {
  /** 窗口标签：5h / 168h(周) 等。 */
  label: string;
  used: number;
  total: number;
  remaining: number;
  pct: number;
  /** 重置时刻（epoch ms）。 */
  resetAt: number;
}

interface ZaiQuota {
  ok: boolean;
  reason?: string;
  /** 套餐档位（如 Lite / Pro / Max）。 */
  level?: string;
  windows?: QuotaWindow[];
}

/** 从宿主凭据存储解析一个引用的值。 */
async function resolveCredential(
  ctx: Context,
  ref: string,
): Promise<string | undefined> {
  const credentials = ctx.get("credentials") as
    | { resolve(ref: string): Promise<{ value: string } | undefined> }
    | undefined;
  const resolved = await credentials?.resolve(ref);
  return resolved?.value;
}

/** 60 秒缓存包装：余额/配额变化慢，前端轮询不必每次打上游。 */
function cached<T>(fetcher: () => Promise<T>): () => Promise<T> {
  let entry: { at: number; value: T } | null = null;
  return async () => {
    if (entry !== null && Date.now() - entry.at < 60_000) return entry.value;
    const value = await fetcher();
    entry = { at: Date.now(), value };
    return value;
  };
}

async function fetchDeepseekBalance(ctx: Context): Promise<DeepseekBalance> {
  const key = await resolveCredential(ctx, "DEEPSEEK_API_KEY");
  if (key === undefined || key.length === 0)
    return { ok: false, reason: "unconfigured" };
  try {
    const response = await fetch("https://api.deepseek.com/user/balance", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const parsed = (await response.json()) as {
      is_available?: boolean;
      balance_infos?: {
        currency?: string;
        total_balance?: string;
        granted_balance?: string;
        topped_up_balance?: string;
      }[];
    };
    return {
      ok: true,
      isAvailable: parsed.is_available === true,
      balances: (parsed.balance_infos ?? []).map((info) => ({
        currency: info.currency ?? "",
        total: Number(info.total_balance ?? 0),
        granted: Number(info.granted_balance ?? 0),
        toppedUp: Number(info.topped_up_balance ?? 0),
      })),
    };
  } catch {
    return { ok: false, reason: "network" };
  }
}

async function fetchZaiQuota(ctx: Context): Promise<ZaiQuota> {
  const key = await resolveCredential(ctx, "ZAI_CODING_CN_API_KEY");
  if (key === undefined || key.length === 0)
    return { ok: false, reason: "unconfigured" };
  try {
    const response = await fetch(
      "https://bigmodel.cn/api/monitor/usage/quota/limit",
      {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const parsed = (await response.json()) as {
      code?: number;
      data?: {
        level?: string;
        limits?: {
          type?: string;
          unit?: number;
          number?: number;
          usage?: number;
          currentValue?: number;
          remaining?: number;
          percentage?: number;
          nextResetTime?: number;
        }[];
      };
    };
    if (parsed.code !== 200)
      return { ok: false, reason: `code ${parsed.code}` };
    const windows = (parsed.data?.limits ?? [])
      .filter((limit) => limit.type === "CREDIT_LIMIT")
      .map((limit) => ({
        label:
          limit.unit === 3
            ? `${limit.number ?? 1}时`
            : limit.unit === 6
              ? (limit.number ?? 1) === 1
                ? "周"
                : `${limit.number}w`
              : `u${limit.unit}x${limit.number}`,
        used: limit.currentValue ?? 0,
        total: limit.usage ?? 0,
        remaining: limit.remaining ?? 0,
        pct: Math.max(0, Math.min(100, Math.round(limit.percentage ?? 0))),
        resetAt: limit.nextResetTime ?? 0,
      }))
      .sort((a, b) => a.resetAt - b.resetAt);
    return {
      ok: true,
      ...(parsed.data?.level !== undefined ? { level: parsed.data.level } : {}),
      windows,
    };
  } catch {
    return { ok: false, reason: "network" };
  }
}

/** Copilot 一个配额窗口的精简快照。 */
interface CopilotQuotaWindow {
  /** 配额名：premium_interactions / chat / completions。 */
  id: string;
  /** 配额总量（积分）；unlimited 时为 0。 */
  entitlement: number;
  /** 剩余量（可为负：免费档用超后挂账）。 */
  remaining: number;
  /** 已用量（credits_used）。 */
  used: number;
  /** 剩余百分比（0-100，负值截为 0）。 */
  percentRemaining: number;
  unlimited: boolean;
  overagePermitted: boolean;
}

interface CopilotUsage {
  ok: boolean;
  /** unconfigured（未登录）/ HTTP n / network */
  reason?: string;
  /** 套餐档（copilot_plan：individual / business / enterprise …）。 */
  plan?: string;
  /** 具体 SKU（access_type_sku，如 free_engaged_oss_quota）。 */
  sku?: string;
  /** 配额重置日（ISO 日期，无时刻，GitHub 按自然月重置）。 */
  resetDate?: string;
  quotas?: CopilotQuotaWindow[];
}

/** 把 copilot_internal/user 响应精简成用量卡需要的字段（测试出口）。 */
export function normalizeCopilotUsage(parsed: unknown): CopilotUsage {
  if (parsed === null || typeof parsed !== "object") return { ok: false };
  const raw = parsed as {
    copilot_plan?: unknown;
    access_type_sku?: unknown;
    quota_reset_date?: unknown;
    quota_snapshots?: Record<string, unknown>;
  };
  const windows: CopilotQuotaWindow[] = [];
  for (const id of ["premium_interactions", "chat", "completions"]) {
    const snapshot = raw.quota_snapshots?.[id];
    if (snapshot === null || typeof snapshot !== "object") continue;
    const quota = snapshot as Record<string, unknown>;
    const number = (key: string): number =>
      typeof quota[key] === "number" && Number.isFinite(quota[key])
        ? (quota[key] as number)
        : 0;
    windows.push({
      id,
      entitlement: number("entitlement"),
      remaining: number("remaining"),
      used: number("credits_used"),
      percentRemaining: Math.max(0, Math.min(100, number("percent_remaining"))),
      unlimited: quota.unlimited === true,
      overagePermitted: quota.overage_permitted === true,
    });
  }
  const plan =
    typeof raw.copilot_plan === "string" && raw.copilot_plan.length > 0
      ? raw.copilot_plan
      : undefined;
  const sku =
    typeof raw.access_type_sku === "string" && raw.access_type_sku.length > 0
      ? raw.access_type_sku
      : undefined;
  const resetDate =
    typeof raw.quota_reset_date === "string" && raw.quota_reset_date.length > 0
      ? raw.quota_reset_date
      : undefined;
  return {
    ok: true,
    ...(plan !== undefined ? { plan } : {}),
    ...(sku !== undefined ? { sku } : {}),
    ...(resetDate !== undefined ? { resetDate } : {}),
    quotas: windows,
  };
}

/** Copilot 凭据里的 GitHub OAuth 长效令牌（copilot_internal API 用它鉴权）。 */
async function readCopilotRefreshToken(): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(copilotAuthFile(), "utf8"),
    );
    if (parsed === null || typeof parsed !== "object") return undefined;
    const token = (parsed as { refresh?: unknown }).refresh;
    return typeof token === "string" && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

async function fetchCopilotUsage(): Promise<CopilotUsage> {
  const token = await readCopilotRefreshToken();
  if (token === undefined) return { ok: false, reason: "unconfigured" };
  try {
    const response = await fetch(
      "https://api.github.com/copilot_internal/user",
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "dsh-config",
        },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    return normalizeCopilotUsage(await response.json());
  } catch {
    return { ok: false, reason: "network" };
  }
}

/** 带标准头的 JSON 响应。 */
function respondJson(
  response: {
    writeHead(code: number, headers?: Record<string, string>): unknown;
    end(body?: string): unknown;
  },
  body: unknown,
): void {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

export function apply(ctx: Context): void {
  const headers = new WeakMap<object, Header>();
  const path = dataPath();
  let file: UsageFile = emptyFile();
  let loaded = load(path).then((value) => {
    // today 只保留当前自然日：跨天启动时旧 today 残留（已进各天聚合）应剔除，
    // 避免"今天"的明细错乱混入历史天。
    const tKey = dayKeyOf(Date.now());
    value.today = Array.isArray(value.today)
      ? value.today.filter((record) => dayKeyOf(record.at) === tKey)
      : [];
    file = value;
    refreshCache(value);
  });
  let todayKey = dayKeyOf(Date.now());
  // 防抖批量写盘：变更后 2s 内合并一次写，避免每条记录全量重写文件。
  let dirty = false;
  let saveTimer: NodeJS.Timeout | undefined;
  let writes = Promise.resolve();

  const scheduleSave = (): void => {
    dirty = true;
    if (saveTimer !== undefined) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      if (!dirty) return;
      dirty = false;
      writes = writes
        .then(() => save(path, file))
        .catch((error: unknown) => {
          ctx
            .logger("dsh-config")
            .warn(
              "无法保存 Token 用量：%s",
              error instanceof Error ? error.message : String(error),
            );
        });
    }, 2_000);
  };

  // 惰性序列化缓存 + etag：空闲轮询直接 304，零 payload。
  let serialized: string | null = null;
  let etag = "";

  const refreshCache = (next: UsageFile): void => {
    const last = next.today[next.today.length - 1];
    etag = `${Object.keys(next.days).length}:${next.today.length}:${last?.id ?? ""}`;
    serialized = null;
  };

  const account = (session: Session, event: SessionEvent): void => {
    if (event.type === "request/header") {
      headers.set(session, event.data.header.config);
      return;
    }
    let usage:
      | {
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
        }
      | undefined;
    let turn: number | undefined;
    let step: number | undefined;
    // 0.2.0：usage 直接挂在 assistant/message 事件数据上（旧的
    // assistant/chunk 事件已移除，attempt 事件不携带 usage）。
    if (event.type === "assistant/message" && event.data.usage !== undefined) {
      usage = event.data.usage;
      turn = event.data.turn;
      step = event.data.step;
    }
    if (usage === undefined || turn === undefined || step === undefined) return;
    // 路由来源优先用 session 持久化的 request/context（跨重启可靠，重启后
    // headers WeakMap 会因历史事件不重放而缺失，导致漏记）；回退 WeakMap。
    const context = session.requestContext();
    const header: { provider: string; model: string } | undefined =
      context !== undefined &&
      context.provider.length > 0 &&
      context.model.length > 0
        ? { provider: context.provider, model: context.model }
        : headers.get(session);
    const model = modelOf(header?.provider ?? "", header?.model ?? "");
    if (model === undefined) return;
    const provider = header?.provider ?? "";
    const id = `${session.id}:${turn}:${step}`;
    const costs = costOf(provider, model, event.time, usage);
    const record: UsageRecord = {
      id,
      at: event.time,
      project: projectName(session.header.cwd),
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      ...costs,
    };
    // 跨天检测：today 明细只保留当前自然日。
    const key = dayKeyOf(event.time);
    if (key !== todayKey) {
      todayKey = key;
      file.today = [];
    }
    // 幂等：同 turn/step 重复事件（如重放）只折叠一次。
    const existing = file.today.findIndex((entry) => entry.id === id);
    const day = (file.days[key] ??= {
      total: emptyCell(),
      byProject: {},
      byModel: {},
      cells: {},
    });
    const cell = cellOf(record);
    const cellKey = `${record.project}\u0000${record.model}`;
    if (existing >= 0) {
      // 覆盖：按旧记录的 project/model 撤销对应分桶，再累加新值。
      // 注意：分桶一律直接操作 day 属性，不能缓存引用——覆盖分支里
      // 重新赋值会让旧引用指向被替换对象，导致分桶累加失效（历史 bug）。
      const old = file.today[existing];
      if (old !== undefined) {
        const oldCell = cellOf(old);
        day.total = subtractCell(day.total, oldCell);
        const oldProjectBucket = day.byProject[old.project];
        if (oldProjectBucket !== undefined)
          day.byProject[old.project] = subtractCell(oldProjectBucket, oldCell);
        const oldModelBucket = day.byModel[old.model];
        if (oldModelBucket !== undefined)
          day.byModel[old.model] = subtractCell(oldModelBucket, oldCell);
        const oldCellKey = `${old.project}\u0000${old.model}`;
        const oldBucket = day.cells[oldCellKey];
        if (oldBucket !== undefined)
          day.cells[oldCellKey] = subtractCell(oldBucket, oldCell);
        file.today[existing] = record;
      }
    } else {
      file.today.push(record);
    }
    addCell(day.total, cell);
    const projectBucket = (day.byProject[record.project] ??= emptyCell());
    addCell(projectBucket, cell);
    const modelBucket = (day.byModel[record.model] ??= emptyCell());
    addCell(modelBucket, cell);
    const bucket = (day.cells[cellKey] ??= emptyCell());
    addCell(bucket, cell);
    void loaded.then(() => {
      refreshCache(file);
      scheduleSave();
    });
  };

  ctx.on("session/event", account);

  // 供应商状态代理：DeepSeek 余额 + 智谱套餐配额 + Copilot 配额（宿主持
  // 凭据代取，60 秒缓存）。
  const deepseekBalance = cached(() => fetchDeepseekBalance(ctx));
  const zaiQuota = cached(() => fetchZaiQuota(ctx));
  const copilotUsage = cached(() => fetchCopilotUsage());
  const providerRoute: WebRoute = {
    kind: "exact",
    path: PROVIDER_ROUTE,
    handler: async (request, response) => {
      if (request.headers[HEADER] !== HEADER_VALUE) {
        response.writeHead(403).end();
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }
      const kind = new URL(request.url ?? "/", "http://x").searchParams.get(
        "kind",
      );
      const payload =
        kind === "zai"
          ? await zaiQuota()
          : kind === "copilot"
            ? await copilotUsage()
            : await deepseekBalance();
      respondJson(response, payload);
    },
  };
  ctx.effect(
    () => ctx.webServer.register(providerRoute),
    "dsh-config: provider status API",
  );

  const route: WebRoute = {
    kind: "exact",
    path: ROUTE,
    handler: async (request, response) => {
      if (request.headers[HEADER] !== HEADER_VALUE) {
        response.writeHead(403).end();
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }
      if (etag !== "" && request.headers["if-none-match"] === etag) {
        response.writeHead(304).end();
        return;
      }
      await loaded;
      if (serialized === null) {
        serialized = JSON.stringify({ ok: true, ...file });
      }
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
        etag,
      });
      response.end(serialized);
    },
  };
  ctx.effect(
    () => ctx.webServer.register(route),
    "dsh-config: token calendar API",
  );
}

interface Header {
  provider: string;
  model: string;
}

function subtractCell(target: CellSummary, source: CellSummary): CellSummary {
  return {
    calls: target.calls - source.calls,
    input: target.input - source.input,
    output: target.output - source.output,
    cacheRead: target.cacheRead - source.cacheRead,
    cacheWrite: target.cacheWrite - source.cacheWrite,
    cost: target.cost - source.cost,
    peakCost: target.peakCost - source.peakCost,
    offCost: target.offCost - source.offCost,
  };
}
