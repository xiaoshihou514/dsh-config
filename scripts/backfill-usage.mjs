#!/usr/bin/env node
/**
 * 用量回填脚本（一次性工具，保留备复用）。
 *
 * 背景：opencodex 供应商 2026-11-13 起才纳入 usage-api.ts 记账白名单，
 * 此前所有事件被丢弃；另有 deepseek-flash 更名空窗（2026-10-17~10-19）
 * 与 v1→v2 迁移期的零散缺口。本脚本扫描近 30 天会话日志
 * （$DSH_HOME/sessions 下各会话的 session*.jsonl.zstd，zstd 解压流式逐行读，
 * 只处理 assistant/message 事件），按现行 modelOf/costOf 规则重建记录，
 * 与 usage.json 存量按「天 × 模型」对比调用次数差额，仅把缺口折叠写入
 * days 聚合桶（不动 today 明细）。
 *
 * 幂等性：以「天 × 模型」的调用次数差额为准（目标值 = 会话扫描结果），
 * 先 diff 再补，重复执行不叠加。days 里今天（当天聚合桶）的缺口同样补齐，
 * 保证回填后按天汇总与扫描结果一致。
 *
 * 安全：写前在同目录生成带时间戳的 usage.json 备份；写前重新读取磁盘上
 * 的最新文件合并到内存再原子改名写入，尽量缩小与实时记账的碰撞窗口。
 * 建议在 dsh 停机窗口运行；宿主侧白名单需重启 dsh 才生效，**重启后再跑
 * 一次本脚本**可补齐重启前的记账空窗。
 *
 * 用法：node scripts/backfill-usage.mjs [--days 30] [--dry-run]
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { glob } from "node:fs/promises";

// ===== 与 usage-api.ts 保持一致的计价/白名单规则 =====

const OFFICIAL_PROVIDER = "deepseek-official";
const SUBSCRIPTION_PROVIDERS = new Set([
  "opencode-free",
  "kimi-coding",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
  "opencode-go",
]);
const PRICED_PROVIDERS = new Set(["zai-coding-cn"]);

// 美元牌价估算档：与 usage-api.ts 保持一致（2026-11-13 起 claude / gpt /
// grok / kimi 系按牌价估算，固定汇率 7.2，单一价无峰谷，未收录记 0）。
const USD_PRICED_PROVIDERS = new Set([
  "opencodex",
  "openai-codex",
  "github-copilot",
]);
const USD_CNY = 7.2;
const USD_PRICE = {
  "claude-opus-5-5": { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
  "claude-sonnet-5": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  "gpt-5.6-luna": { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 },
  "gpt-6-luna": { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
  "gpt-5.6-terra": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 },
  "gpt-5.3-codex-spark": { input: 1.75, cacheRead: 0.175, cacheWrite: 1.75, output: 14 },
  "grok-4.7": { input: 2, cacheRead: 0.5, cacheWrite: 2, output: 6 },
  "grok-4.7--fast": { input: 4, cacheRead: 1, cacheWrite: 4, output: 12 },
  "kimi-k3": { input: 3, cacheRead: 0.3, cacheWrite: 3, output: 15 },
};
function usdPriceOf(model) {
  const slash = model.lastIndexOf("/");
  return USD_PRICE[slash === -1 ? model : model.slice(slash + 1)];
}

const ZAI_PRICE = {
  "glm-5.3-flash": { hit: 0.23, miss: 0.8, output: 2.8 },
  "glm-5.3-flashx": { hit: 0.57, miss: 2, output: 7 },
  "glm-5.3": { hit: 2, miss: 8, output: 28 },
  "glm-5.2": { hit: 2, miss: 8, output: 28 },
  "glm-5.1": { hit: 1.3, miss: 6, output: 24 },
  "glm-5-turbo": { hit: 1.2, miss: 5, output: 22 },
  "glm-5": { hit: 1, miss: 4, output: 18 },
};

const PEAK_PRICE = {
  flash: { hit: 0.1, miss: 3, output: 9 },
  pro: { hit: 0.3, miss: 9, output: 27 },
};
const OFF_RATIO = 0.5;

function isPeak(time) {
  const hour = new Date(time + 8 * 3_600_000).getUTCHours();
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}
function isZaiPeak(time) {
  const beijing = new Date(time + 8 * 3_600_000);
  const day = beijing.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = beijing.getUTCHours();
  return hour >= 14 && hour < 18;
}

function costOf(provider, model, at, record) {
  if (SUBSCRIPTION_PROVIDERS.has(provider))
    return { cost: 0, peakCost: 0, offCost: 0 };
  const cacheRead = record.cacheReadTokens ?? 0;
  const cacheWrite = record.cacheWriteTokens ?? 0;
  if (USD_PRICED_PROVIDERS.has(provider)) {
    const price = usdPriceOf(model);
    if (price === undefined) return { cost: 0, peakCost: 0, offCost: 0 };
    const cost =
      (((record.inputTokens + cacheWrite) * price.input +
        cacheRead * price.cacheRead +
        cacheWrite * (price.cacheWrite - price.input) +
        record.outputTokens * price.output) /
        1_000_000) *
      USD_CNY;
    return { cost, peakCost: 0, offCost: 0 };
  }
  if (PRICED_PROVIDERS.has(provider)) {
    const bare = model.slice(provider.length + 1).toLowerCase();
    const price = ZAI_PRICE[bare];
    if (price === undefined) return { cost: 0, peakCost: 0, offCost: 0 };
    const base =
      (cacheRead * price.hit +
        (record.inputTokens + cacheWrite) * price.miss +
        record.outputTokens * price.output) /
      1_000_000;
    return isZaiPeak(at)
      ? { cost: base, peakCost: base, offCost: 0 }
      : { cost: base * 0.5, peakCost: 0, offCost: base * 0.5 };
  }
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
  const peakTime = isPeak(at);
  const cost = peakTime ? peak : off;
  return {
    cost,
    peakCost: peakTime ? cost : 0,
    offCost: peakTime ? 0 : cost,
  };
}

function modelOf(provider, model) {
  if (provider === OFFICIAL_PROVIDER) {
    return model === "deepseek-v4-pro" ||
      model === "deepseek-v4-flash" ||
      model === "deepseek-flash"
      ? model
      : undefined;
  }
  if (
    (SUBSCRIPTION_PROVIDERS.has(provider) ||
      PRICED_PROVIDERS.has(provider) ||
      USD_PRICED_PROVIDERS.has(provider)) &&
    model !== ""
  )
    return `${provider}/${model}`;
  return undefined;
}

function projectName(cwd) {
  return cwd === undefined ? "未指定项目" : basename(cwd) || cwd;
}

function dayKeyOf(time) {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// ===== 数据结构 =====

function emptyCell() {
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
function addCell(target, source) {
  for (const key of Object.keys(emptyCell())) target[key] += source[key];
}
function cellOf(record) {
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

function dshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
}

// ===== 扫描会话日志 =====

/** 解析一个 zstd 文件，逐行回调 JSON 对象；返回 Promise（流式，低内存）。 */
function readZstdLines(file, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn("zstd", ["-dc", file]);
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.length === 0) continue;
        try {
          onLine(JSON.parse(line));
        } catch {
          /* 跳过无法解析的行 */
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`zstd 退出码 ${code}: ${file}`)),
    );
  });
}

async function scanSessions(windowMs) {
  const cutoff = Date.now() - windowMs;
  const home = dshHome();
  const root = join(home, "sessions");
  /** files: [目录名, 文件路径] —— 目录名即会话 id（session-xxx 或裸 uuid）。 */
  const files = [];
  for await (const entry of glob("**/session*.jsonl.zstd", { cwd: root })) {
    const sessionDir = entry.split("/")[0];
    files.push([sessionDir, join(root, entry)]);
  }
  console.log(`扫描 ${files.length} 个会话文件（近 ${Math.round(windowMs / 86_400_000)} 天）…`);

  // 扫描结果：天 × 模型 → 聚合；记录缺失 session 时项目名用目录推导不可行，
  // 因此按「记录仍存在的事件」逐条保留用于折叠（内存放得下：缺口级别几千条）。
  const scanned = new Map(); // `${day}\u0000${model}` -> CellSummary（目标值）
  const scannedCost = new Map(); // `${day}\u0000${project}\u0000${model}` -> 目标费用（元）
  const records = []; // 待折叠的完整记录（含 project），折叠时再按存量裁剪
  let events = 0;

  for (const [sessionId, file] of files) {
    const lines = [];
    let cwd;
    let first = true;
    await readZstdLines(file, (obj) => {
      if (first) {
        first = false;
        cwd = obj?.type === "session" ? obj.cwd : undefined;
      }
      if (obj?.type !== "assistant/message") return;
      const time = obj.time ?? 0;
      if (time < cutoff) return;
      const data = obj.data ?? {};
      const usage = data.usage;
      const source = data.message?.source ?? {};
      const provider = source.provider;
      const model = source.model;
      if (!usage || !provider) return;
      lines.push({ time, data, usage, provider, model });
    });
    // 会话 cwd：从首行 session 元数据拿（上面回调里没存，重读首行成本高；
    // 改为在回调里顺带记录）。
    for (const item of lines) {
      const key = modelOf(item.provider, item.model);
      if (key === undefined) continue;
      events += 1;
      const costs = costOf(item.provider, key, item.time, item.usage);
      records.push({
        id: `${sessionId}:${item.data.turn}:${item.data.step}`,
        at: item.time,
        day: dayKeyOf(item.time),
        model: key,
        project: projectName(cwd),
        inputTokens: item.usage.inputTokens ?? 0,
        outputTokens: item.usage.outputTokens ?? 0,
        cacheReadTokens: item.usage.cacheReadTokens ?? 0,
        cacheWriteTokens: item.usage.cacheWriteTokens ?? 0,
        ...costs,
      });
      const day = dayKeyOf(item.time);
      const cellKey = `${day}\u0000${key}`;
      const bucket = scanned.get(cellKey) ?? emptyCell();
      addCell(bucket, cellOf(records[records.length - 1]));
      scanned.set(cellKey, bucket);
      const record = records[records.length - 1];
      const triple = `${record.day}\u0000${record.project}\u0000${record.model}`;
      scannedCost.set(triple, (scannedCost.get(triple) ?? 0) + record.cost);
    }
  }
  return { scanned, scannedCost, records, events };
}

// ===== 主流程 =====

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const daysIndex = args.indexOf("--days");
  const windowDays = daysIndex !== -1 ? Number(args[daysIndex + 1]) : 30;

  const path = join(dshHome(), "dsh-config", "usage.json");
  const before = JSON.parse(await readFile(path, "utf8"));
  const beforeTotals = totalCalls(before);

  const files = [];
  const root = join(dshHome(), "sessions");
  for await (const entry of glob("**/session*.jsonl.zstd", { cwd: root })) {
    files.push([entry.split("/")[0], join(root, entry)]);
  }
  const { scanned, scannedCost, records, events } = await scanSessions(
    windowMs(windowDays),
  );
  console.log(`扫描到 ${events} 条带 usage 的记账事件（模型键有效）。`);

  // 与存量按「天 × 模型」算差额；只折叠缺口对应的记录。
  const file = structuredClone(before);
  file.version = 2;
  file.days ??= {};
  const todayKey = dayKeyOf(Date.now());
  let folded = 0;
  const perModel = new Map(); // cellKey -> 补录次数（报告用）
  const initialByCell = new Map(); // cellKey -> 循环开始时的存量调用数
  for (const record of records) {
    const cellKey = `${record.day}\u0000${record.model}`;
    const target = scanned.get(cellKey);
    const day = file.days[record.day] ?? {
      total: emptyCell(),
      byProject: {},
      byModel: {},
      cells: {},
    };
    // 该（天×模型）还需补多少条：只补差额，超出部分跳过（幂等关键）。
    // 存量取循环开始时的快照（initialCalls），不能用 day.byModel 实时值——
    // 折叠过程中桶在增长，实时值会把已折叠的条数重复计入，导致补一半就停。
    let initialCalls = initialByCell.get(cellKey);
    if (initialCalls === undefined) {
      initialCalls = day.byModel[record.model]?.calls ?? 0;
      initialByCell.set(cellKey, initialCalls);
    }
    const goal = target?.calls ?? 0;
    const modelBucketCount = perModel.get(cellKey) ?? 0;
    if (initialCalls + modelBucketCount >= goal) continue;
    perModel.set(cellKey, modelBucketCount + 1);

    const cell = cellOf(record);
    addCell(day.total, cell);
    const projectBucket = day.byProject[record.project] ?? emptyCell();
    addCell(projectBucket, cell);
    day.byProject[record.project] = projectBucket;
    const modelBucket = day.byModel[record.model] ?? emptyCell();
    addCell(modelBucket, cell);
    day.byModel[record.model] = modelBucket;
    const pairKey = `${record.project}\u0000${record.model}`;
    const pairBucket = day.cells[pairKey] ?? emptyCell();
    addCell(pairBucket, cell);
    day.cells[pairKey] = pairBucket;
    file.days[record.day] = day;
    folded += 1;
  }

  // 费用补差：这些模型的存量费用是按旧口径（记 0）落的，条数已齐但费用
  // 缺失。按「天 × 项目 × 模型」三元组把目标费用与存量费用的差额直接加进
  // 聚合桶（calls/词元不变，只补 cost）。
  let costAdjusted = 0;
  let costDeltaTotal = 0;
  for (const [triple, goalCost] of scannedCost) {
    if (goalCost <= 0) continue;
    const [day, project, model] = triple.split("\u0000");
    const bucket = file.days[day];
    if (bucket === undefined) continue;
    const stored =
      bucket.cells[`${project}\u0000${model}`]?.cost ?? 0;
    const delta = goalCost - stored;
    if (delta <= 1e-9) continue;
    bucket.total.cost += delta;
    const modelBucket = bucket.byModel[model];
    if (modelBucket !== undefined) modelBucket.cost += delta;
    const projectBucket = bucket.byProject[project];
    if (projectBucket !== undefined) projectBucket.cost += delta;
    const pairBucket = bucket.cells[`${project}\u0000${model}`];
    if (pairBucket !== undefined) pairBucket.cost += delta;
    costAdjusted += 1;
    costDeltaTotal += delta;
  }

  const afterTotals = totalCalls(file);
  console.log(`补录 ${folded} 条记录到 days 聚合（today 明细未动）。`);
  for (const [model, n] of [...groupModel(perModel)].sort((a, b) => b[1] - a[1]))
    console.log(`  ${model}: +${n}`);
  console.log(
    `调用次数总量：${beforeTotals} → ${afterTotals}（净增 ${afterTotals - beforeTotals}）`,
  );
  if (costAdjusted > 0)
    console.log(
      `费用补差 ${costAdjusted} 个（天×项目×模型）桶，合计补 ¥${costDeltaTotal.toFixed(2)}`,
    );
  if (dryRun) {
    console.log("dry-run：不写盘。");
    return;
  }

  // 备份 + 重新读盘合并 + 原子写入。
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.${stamp}.bak`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(backup, await readFile(path), { mode: 0o600 });
  console.log(`已备份原文件到 ${backup}`);

  // 碰撞窗口收敛：若磁盘文件已变化（实时记账写入过），把新增内容折叠进
  // 我们的结果里再写——按「天 × 模型 × 调用次数差额」补齐盘上比我们多的部分。
  const disk = JSON.parse(await readFile(path, "utf8"));
  const merged = mergeDiskChanges(file, disk, before);

  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(merged)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
  console.log(`已写回 ${path}`);
}

function windowMs(days) {
  return days * 86_400_000;
}

/** 全文件调用次数合计。 */
function totalCalls(file) {
  let sum = 0;
  for (const day of Object.values(file.days ?? {})) {
    for (const cell of Object.values(day.byModel ?? {})) sum += cell.calls;
  }
  return sum;
}

/** 把 perModel（`${day}\u0000${model}` -> n）按模型聚合。 */
function groupModel(perModel) {
  const out = new Map();
  for (const [key, n] of perModel) {
    const model = key.split("\u0000")[1];
    out.set(model, (out.get(model) ?? 0) + n);
  }
  return out;
}

/**
 * 若磁盘上文件比扫描时的 before 新（实时记账又写入了），把磁盘上多出来的
 * 部分保留：以磁盘为基线，叠加我们的补录差额。实现：对每个（天×模型），
 * 目标 calls = max(磁盘值, 我们的目标值)…… 这里采用更直接的策略——
 * 磁盘若是更新的，把它当 before 重算一次补录量过于复杂；简化为：
 * 若磁盘与 before 相同则直接写；不同则警告退出，由人工重跑（幂等保证
 * 重跑只补差额，不会叠加）。
 */
function mergeDiskChanges(file, disk, before) {
  const diskStr = JSON.stringify(sortKeys(disk));
  const beforeStr = JSON.stringify(sortKeys(before));
  if (diskStr === beforeStr) return file;
  throw new Error(
    "检测到 usage.json 在扫描期间被并发修改（实时记账已写盘）。" +
      "为避免覆盖，请稍后重跑本脚本：幂等设计保证重跑只补剩余差额。",
  );
}

/** 键排序的稳定序列化（仅用于比较）。 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

main().catch((error) => {
  console.error("回填失败：", error);
  process.exitCode = 1;
});
