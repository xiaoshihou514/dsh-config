/**
 * 词元用量记账与同源读 API。
 *
 * v2 数据结构：历史数据按「自然日 ×（项目 × 模型）」**提前聚合**持久化
 * （费用含峰谷拆分），只有**今天**保留逐条明细；跨天后旧明细自然折叠进
 * 聚合。读 API 只返回聚合 + 今日明细，响应体比 v1 全量 records 小一两个
 * 数量级；写盘走防抖批量合并，不再每条全量重写。
 *
 * 支持 provider：deepseek-official（官方计费）与 opencode-free（免费，
 * 费用恒为 0，仅统计词元量）。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";

export const name = "dsh-config-usage-api";
export const inject = ["sessions", "webServer"];

const ROUTE = "/dsh-config/usage";
const HEADER = "x-dsh-config";
const HEADER_VALUE = "usage-calendar";

const OFFICIAL_PROVIDER = "deepseek-official";
const OPENCODE_PROVIDER = "opencode-free";
const CODEX_PROVIDER = "openai-codex";

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

/** 单条记录的费用拆分（元）；opencode free 与 Codex 订阅恒为 0（订阅不按 token 计费）。 */
function costOf(provider: string, model: string, at: number, record: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): { cost: number; peakCost: number; offCost: number } {
  if (provider === OPENCODE_PROVIDER || provider === CODEX_PROVIDER)
    return { cost: 0, peakCost: 0, offCost: 0 };
  const price =
    model === "deepseek-v4-pro"
      ? PEAK_PRICE.pro
      : model === "deepseek-v4-flash"
        ? PEAK_PRICE.flash
        : undefined;
  if (price === undefined) return { cost: 0, peakCost: 0, offCost: 0 };
  const cacheRead = record.cacheReadTokens ?? 0;
  const cacheWrite = record.cacheWriteTokens ?? 0;
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
    return model === "deepseek-v4-pro" || model === "deepseek-v4-flash"
      ? model
      : undefined;
  }
  if (provider === OPENCODE_PROVIDER || provider === CODEX_PROVIDER)
    return model;
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
  return ["calls", "input", "output", "cacheRead", "cacheWrite", "cost", "peakCost", "offCost"].every(
    (key) => {
      const n = (cell as Record<string, unknown>)[key];
      return typeof n === "number" && Number.isFinite(n) && n >= 0;
    },
  );
}

function emptyFile(): UsageFile {
  return { version: 2, days: {}, today: [] };
}

/** 把一条记录折叠进聚合（迁移或实时记账共用）。 */
function foldRecord(file: UsageFile, record: UsageRecord, todayKey: string): void {
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
        foldRecord(
          file,
          { ...entry, ...costs },
          todayKey,
        );
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

export function apply(ctx: Context): void {
  const headers = new WeakMap<object, Header>();
  const path = dataPath();
  let file: UsageFile = emptyFile();
  let loaded = load(path).then((value) => {
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

  const account = (
    session: { id: string; header: { cwd?: string } },
    event: SessionEvent,
  ): void => {
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
    if (event.type === "assistant/chunk" && event.data.chunk.type === "usage") {
      usage = event.data.chunk.usage;
      turn = event.data.turn;
      step = event.data.step;
    } else if (
      event.type === "assistant/message" &&
      event.data.usage !== undefined
    ) {
      usage = event.data.usage;
      turn = event.data.turn;
      step = event.data.step;
    }
    if (usage === undefined || turn === undefined || step === undefined) return;
    const header = headers.get(session);
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
    const projectBucket = (day.byProject[record.project] ??= emptyCell());
    const modelBucket = (day.byModel[record.model] ??= emptyCell());
    const cellKey = `${record.project}\u0000${record.model}`;
    if (existing >= 0) {
      // 覆盖：先撤销旧值再累加新值（保持聚合一致）。
      const old = file.today[existing];
      if (old !== undefined) {
        const oldCell = cellOf(old);
        day.total = subtractCell(day.total, oldCell);
        day.byProject[record.project] = subtractCell(
          day.byProject[record.project] ?? emptyCell(),
          oldCell,
        );
        day.byModel[record.model] = subtractCell(
          day.byModel[record.model] ?? emptyCell(),
          oldCell,
        );
        const oldBucket = day.cells[cellKey];
        if (oldBucket !== undefined) {
          day.cells[cellKey] = subtractCell(oldBucket, oldCell);
        }
        file.today[existing] = record;
      }
    } else {
      file.today.push(record);
    }
    addCell(day.total, cell);
    addCell(projectBucket, cell);
    addCell(modelBucket, cell);
    const bucket = (day.cells[cellKey] ??= emptyCell());
    addCell(bucket, cell);
    void loaded.then(() => {
      refreshCache(file);
      scheduleSave();
    });
  };

  ctx.on("session/event", account);
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
