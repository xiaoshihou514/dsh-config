import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  IconChevronDownOutline14,
  IconDataOutline16,
  IconGoalOutline16,
  IconListPenOutline16,
  IconRightUpOutline16,
  IconSparkle16,
} from "./icons.tsx";
import { modelGroupKey } from "../usage-models.ts";

type View = "day" | "week" | "month" | "model" | "project";

/** host 已算好的单条明细（仅今天存在）。 */
interface RecordItem {
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

/** 一天的聚合桶（历史数据只有这个，明细已归档）。 */
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

interface DaySummary {
  total: CellSummary;
  byProject: Record<string, CellSummary>;
  byModel: Record<string, CellSummary>;
  cells: Record<string, CellSummary>;
}

interface UsagePayload {
  ok?: boolean;
  days?: Record<string, DaySummary>;
  today?: RecordItem[];
}

interface Totals extends CellSummary {
  tokens: number;
}

function emptySummary(): CellSummary {
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

function addCell(target: CellSummary, source: CellSummary): CellSummary {
  return {
    calls: target.calls + source.calls,
    input: target.input + source.input,
    output: target.output + source.output,
    cacheRead: target.cacheRead + source.cacheRead,
    cacheWrite: target.cacheWrite + source.cacheWrite,
    cost: target.cost + source.cost,
    peakCost: target.peakCost + source.peakCost,
    offCost: target.offCost + source.offCost,
  };
}

function tokensOf(summary: CellSummary): number {
  return (
    summary.input + summary.output + summary.cacheRead + summary.cacheWrite
  );
}

function totalsOf(summary: CellSummary): Totals {
  return { ...summary, tokens: tokensOf(summary) };
}

function sumCells(items: readonly CellSummary[]): CellSummary {
  return items.reduce<CellSummary>(
    (sum, cell) => addCell(sum, cell),
    emptySummary(),
  );
}

/**
 * 某天在项目/模型筛选下应使用的聚合桶。模型筛选值可以是厂商组
 * （`opencode-free` 代表其下所有模型）或单个裸名模型（官方 deepseek）。
 */
function summaryFor(
  day: DaySummary | undefined,
  project: string,
  model: string,
): CellSummary {
  if (day === undefined) return emptySummary();
  if (project === "全部项目" && model === "全部模型") return day.total;

  if (project !== "全部项目" && model !== "全部模型") {
    let sum = emptySummary();
    for (const [key, cell] of Object.entries(day.cells)) {
      const index = key.indexOf("\u0000");
      if (index === -1) continue;
      if (key.slice(0, index) !== project) continue;
      if (modelGroupKey(key.slice(index + 1)) !== model) continue;
      sum = addCell(sum, cell);
    }
    return sum;
  }
  if (project !== "全部项目") return day.byProject[project] ?? emptySummary();
  let sum = emptySummary();
  for (const [key, cell] of Object.entries(day.byModel)) {
    if (modelGroupKey(key) === model) sum = addCell(sum, cell);
  }
  return sum;
}

const DAY = 86_400_000;

function dayStart(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayKeyToStart(key: string): number {
  return new Date(`${key}T00:00:00`).getTime();
}

/**
 * 按日历天数加减（非毫秒数累加）：夏令时切换当天实际只有 23 或 25 小时，
 * `time + n * DAY` 会在切换前后累积 1 小时偏移，导致网格时间戳与
 * `dayKeyToStart` 算出的午夜时间戳对不上（历史格子全部落空，只有切换点
 * 之后的最近几天凑巧仍能命中——即「热力图只显示最近两天」的成因）。
 * `setDate` 按日历字段运算，自动吸收夏令时跳变。
 */
function addDays(time: number, delta: number): number {
  const date = new Date(time);
  date.setDate(date.getDate() + delta);
  return date.getTime();
}

function mondayOf(time: number): number {
  const date = new Date(dayStart(time));
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date.getTime();
}

function label(time: number, view: View): string {
  const date = new Date(time);
  if (view === "month")
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "short",
    }).format(date);
  if (view === "week")
    return `${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date)}当周`;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

function fullLabel(start: number, view: View): string {
  const date = new Date(start);
  if (view === "month")
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "long",
    }).format(date);
  if (view === "week")
    return `${new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(date)} 当周`;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(date);
}

function number(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

/** 中文数字格式：≥1 万显示「x.yz万」，其余四位分组（8887 → 8,887）。 */
function cnDigits(value: number): string {
  if (value >= 10_000) return `${(value / 10_000).toFixed(2)}万`;
  return String(Math.round(value)).replace(/\B(?=(\d{4})+(?!\d))/g, ",");
}

function money(value: number): string {
  return `¥${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
}

function dayKeyOf(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isNextDay(a: string, b: string): boolean {
  // 严格比较毫秒差值会在夏令时切换日误判（该日实际只有 23/25 小时，
  // 差值不等于 86400000）；改为日历日比较。
  return addDays(dayKeyToStart(a), 1) === dayKeyToStart(b);
}

/** 连续使用天数（按聚合里的自然日键）。 */
function streaks(dayKeys: readonly string[]): {
  current: number;
  longest: number;
} {
  const days = Array.from(new Set(dayKeys)).sort();
  if (days.length === 0) return { current: 0, longest: 0 };
  let longest = 1;
  let run = 1;
  for (let index = 1; index < days.length; index += 1) {
    if (isNextDay(days[index - 1] ?? "", days[index] ?? "")) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 1;
    }
  }
  let current = 1;
  for (let index = days.length - 1; index > 0; index -= 1) {
    if (isNextDay(days[index - 1] ?? "", days[index] ?? "")) current += 1;
    else break;
  }
  return { current, longest };
}

function monthLabelFor(weekStart: number): string | undefined {
  const monday = new Date(weekStart);
  const firstOfMonth = new Date(
    monday.getFullYear(),
    monday.getMonth(),
    1,
  ).getTime();
  return firstOfMonth >= weekStart && firstOfMonth < addDays(weekStart, 7)
    ? `${monday.getMonth() + 1}月`
    : undefined;
}

/**
 * 热力图色阶阈值：非零用量按四分位切 4 档——避免量级悬殊时小用量日子
 * 全部被压到最浅档（视觉上像没有数据）。
 */
function quantileThresholds(
  values: readonly number[],
): [number, number, number] {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  const pick = (p: number): number =>
    sorted.length === 0
      ? 0
      : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  return [pick(0.25), pick(0.5), pick(0.75)];
}

function levelFromQuantile(
  value: number,
  thresholds: [number, number, number],
): number {
  if (value <= 0) return 0;
  if (value <= thresholds[0]) return 1;
  if (value <= thresholds[1]) return 2;
  if (value <= thresholds[2]) return 3;
  return 4;
}

function cellColor(level: number): string {
  const base = "var(--dsw-alias-bg-layer-2)";
  if (level === 0) return base;
  const mix = [45, 65, 85, 100][level - 1] ?? 100;
  return `color-mix(in srgb, var(--dsw-alias-state-success-primary) ${mix}%, ${base})`;
}

function Metric({
  icon,
  value,
  label: text,
  hint,
}: {
  icon: ReactNode;
  value: string;
  label: string;
  hint?: ReactNode;
}) {
  return (
    <div
      style={{
        flex: "1 1 150px",
        minWidth: 0,
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 10,
        background: "var(--dsw-alias-bg-layer-2)",
        padding: "12px 14px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: "var(--dsw-alias-label-tertiary)",
          fontSize: 12,
        }}
      >
        {icon}
        <span>{text}</span>
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 20,
          fontWeight: 700,
          letterSpacing: "-0.02em",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </div>
      {hint !== undefined ? (
        <div
          style={{
            marginTop: 5,
            fontSize: 11,
            lineHeight: 1.7,
            color: "var(--dsw-alias-label-tertiary)",
          }}
        >
          {hint}
        </div>
      ) : null}
    </div>
  );
}

interface DayCell {
  at: number;
  summary: CellSummary;
  future: boolean;
}

interface Bucket {
  start: number;
  summary: CellSummary;
}

/** 设置页同款的选择按钮：平台底、圆角、下拉箭头，菜单用 Menu 卡片的表面。 */
function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span style={{ fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}>
        {label}
      </span>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        style={{
          height: 32,
          maxWidth: 220,
          border: "none",
          borderRadius: "var(--dsw-radius-md)",
          background: open
            ? "var(--dsw-alias-interactive-bg-hover)"
            : "var(--dsw-alias-bg-module-platform)",
          color: "var(--dsw-alias-label-primary)",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "0 10px 0 12px",
          font: "inherit",
          fontSize: 13,
          lineHeight: "20px",
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {value}
        </span>
        <IconChevronDownOutline14 />
      </button>
      {open ? (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 20,
            boxSizing: "border-box",
            minWidth: 164,
            maxWidth: 280,
            maxHeight: 280,
            overflowY: "auto",
            padding: 2,
            display: "flex",
            flexDirection: "column",
            border: "1px solid var(--dsw-alias-border-inverted)",
            borderRadius: 7,
            background: "var(--dsw-alias-bg-layer-2)",
            boxShadow: "var(--dsw-shadow-lv3)",
          }}
        >
          {options.map((item) => (
            <button
              key={item}
              type="button"
              role="menuitemradio"
              aria-checked={item === value}
              onClick={() => {
                onChange(item);
                setOpen(false);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                width: "100%",
                minHeight: 26,
                padding: "3px 7px",
                border: "none",
                borderRadius: 5,
                background: "transparent",
                cursor: "pointer",
                font: "inherit",
                fontSize: 12,
                lineHeight: "18px",
                color: "var(--dsw-alias-label-primary)",
                textAlign: "left",
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background =
                  "var(--dsw-alias-interactive-bg-hover)";
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = "transparent";
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item}
              </span>
              {item === value ? (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M3 7.2L5.6 9.8L11 4.2"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function UsageSection() {
  const [days, setDays] = useState<Record<string, DaySummary>>({});
  const [today, setToday] = useState<RecordItem[]>([]);
  const [view, setView] = useState<View>("day");
  const [project, setProject] = useState("全部项目");
  const [model, setModel] = useState("全部模型");
  const [selected, setSelected] = useState<{
    start: number;
    summary: CellSummary;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const etagRef = useRef<string | null>(null);

  useEffect(() => {
    let stale = false;
    const refresh = async () => {
      try {
        const headers: Record<string, string> = {
          "x-dsh-config": "usage-calendar",
        };
        if (etagRef.current !== null)
          headers["if-none-match"] = etagRef.current;
        const response = await fetch("/dsh-config/usage", { headers });
        // 304：数据未变，跳过解析与重渲染。
        if (response.status === 304) {
          if (!stale) {
            setError(null);
            setLoading(false);
          }
          return;
        }
        const payload = (await response.json()) as UsagePayload;
        if (
          !response.ok ||
          !payload.ok ||
          payload.days === undefined ||
          !Array.isArray(payload.today)
        )
          throw new Error("读取用量数据失败");
        const nextEtag = response.headers.get("etag");
        if (!stale) {
          if (nextEtag !== null) etagRef.current = nextEtag;
          setDays(payload.days);
          setToday(payload.today);
          setError(null);
        }
      } catch {
        if (!stale)
          setError("暂时无法读取用量数据，请确认 dsh-config 已完整加载。");
      } finally {
        if (!stale) setLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 15_000);
    return () => {
      stale = true;
      window.clearInterval(timer);
    };
  }, []);

  // 项目/模型列表：今天的明细 + 聚合桶键（历史项目/模型也能出现）。
  const projects = useMemo(() => {
    const set = new Set(today.map((record) => record.project));
    for (const day of Object.values(days)) {
      for (const name of Object.keys(day.byProject)) set.add(name);
    }
    return ["全部项目", ...Array.from(set).sort()];
  }, [days, today]);
  // 模型筛选和图例都按家族归并（deepseek、glm、gpt、x-preview…）。
  const models = useMemo(() => {
    const groups = new Set<string>();
    const add = (model: string) => {
      groups.add(modelGroupKey(model));
    };
    for (const record of today) add(record.model);
    for (const day of Object.values(days)) {
      for (const name of Object.keys(day.byModel)) add(name);
    }
    return ["全部模型", ...Array.from(groups).sort()];
  }, [days, today]);

  // 筛选后的按天聚合索引：key = 自然日字符串。
  const filteredDays = useMemo(() => {
    const map = new Map<string, CellSummary>();
    for (const [key, day] of Object.entries(days)) {
      map.set(key, summaryFor(day, project, model));
    }
    return map;
  }, [days, project, model]);

  const todayStart = useMemo(() => dayStart(Date.now()), []);
  const thisMonday = useMemo(() => mondayOf(todayStart), [todayStart]);

  // 热力图格子：直接查聚合（O(天数)），历史数据无需逐条。
  const dayCells = useMemo(() => {
    const cells = new Map<number, DayCell>();
    for (const [key, summary] of filteredDays) {
      if (summary.calls <= 0) continue;
      const at = dayKeyToStart(key);
      cells.set(at, { at, summary, future: at > todayStart });
    }
    return cells;
  }, [filteredDays, todayStart]);

  const dayWeeks = useMemo(() => {
    const weeks: { start: number; days: DayCell[] }[] = [];
    for (let week = 51; week >= 0; week -= 1) {
      const start = addDays(thisMonday, -week * 7);
      const days: DayCell[] = [];
      for (let offset = 0; offset < 7; offset += 1) {
        const at = addDays(start, offset);
        days.push(
          dayCells.get(at) ?? {
            at,
            summary: emptySummary(),
            future: at > todayStart,
          },
        );
      }
      weeks.push({ start, days });
    }
    return weeks;
  }, [dayCells, thisMonday, todayStart]);

  const weekBuckets = useMemo(() => {
    const buckets: Bucket[] = [];
    for (let week = 15; week >= 0; week -= 1) {
      const start = addDays(thisMonday, -week * 7);
      const end = addDays(start, 7);
      const cells: CellSummary[] = [];
      for (const [key, summary] of filteredDays) {
        const at = dayKeyToStart(key);
        if (at >= start && at < end) cells.push(summary);
      }
      buckets.push({ start, summary: sumCells(cells) });
    }
    return buckets;
  }, [filteredDays, thisMonday]);

  const monthBuckets = useMemo(() => {
    const now = new Date(todayStart);
    const anchor = now.getFullYear() * 12 + now.getMonth();
    const buckets: Bucket[] = [];
    for (let offset = 11; offset >= 0; offset -= 1) {
      const total = anchor - offset;
      const start = new Date(Math.floor(total / 12), total % 12, 1).getTime();
      const end = new Date(
        Math.floor(total / 12),
        (total % 12) + 1,
        1,
      ).getTime();
      const cells: CellSummary[] = [];
      for (const [key, summary] of filteredDays) {
        const at = dayKeyToStart(key);
        if (at >= start && at < end) cells.push(summary);
      }
      buckets.push({ start, summary: sumCells(cells) });
    }
    return buckets;
  }, [filteredDays, todayStart]);

  // 当前视图展示区间的汇总（与筛选联动）。

  const metrics = useMemo(() => {
    const all = sumCells(Array.from(filteredDays.values()));
    const { current, longest } = streaks(Array.from(filteredDays.keys()));
    let peakDay = 0;
    for (const summary of filteredDays.values())
      peakDay = Math.max(peakDay, tokensOf(summary));
    return {
      tokens: tokensOf(all),
      peakDay,
      cost: all.cost,
      current,
      longest,
    };
  }, [filteredDays]);

  // 三个视图的色阶阈值：非零用量按四分位切档。
  const dayLevels = quantileThresholds(
    dayCells.size > 0
      ? Array.from(dayCells.values(), (cell) => tokensOf(cell.summary))
      : [],
  );
  const weekLevels = quantileThresholds(
    weekBuckets.map((bucket) => tokensOf(bucket.summary)),
  );
  const monthLevels = quantileThresholds(
    monthBuckets.map((bucket) => tokensOf(bucket.summary)),
  );

  // 按模型 / 按项目视图：最近 30 天的每日分段分布（堆叠柱数据）。
  const dailyBreakdown = useMemo(() => {
    if (view !== "model" && view !== "project") return null;
    const byModel = view === "model";
    // 覆盖从最早记录到今天的全部天数（而不是只有最近 30 天）。
    const firstAt = Object.keys(days)
      .map((key) => dayKeyToStart(key))
      .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
    const startAt = Number.isFinite(firstAt)
      ? Math.min(firstAt, todayStart)
      : todayStart;
    const span = Math.max(1, Math.round((todayStart - startAt) / DAY) + 1);
    const daysOut: {
      key: string;
      at: number;
      total: CellSummary;
      segments: { name: string; cell: CellSummary }[];
    }[] = [];
    for (let offset = 0; offset < span; offset += 1) {
      const at = addDays(startAt, offset);
      const key = dayKeyOf(at);
      const day = days[key];
      if (day === undefined) {
        daysOut.push({ key, at, total: emptySummary(), segments: [] });
        continue;
      }
      const totals = new Map<string, CellSummary>();
      if (byModel) {
        if (project !== "全部项目") {
          for (const [cellKey, cell] of Object.entries(day.cells)) {
            const index = cellKey.indexOf("\u0000");
            if (index === -1 || cellKey.slice(0, index) !== project) continue;
            const stored = cellKey.slice(index + 1);
            const family = modelGroupKey(stored);
            if (model !== "全部模型" && family !== model) continue;
            totals.set(family, addCell(bucketOf(totals, family), cell));
          }
        } else {
          for (const [stored, cell] of Object.entries(day.byModel)) {
            const family = modelGroupKey(stored);
            if (model !== "全部模型" && family !== model) continue;
            totals.set(family, addCell(bucketOf(totals, family), cell));
          }
        }
      } else {
        if (model !== "全部模型") {
          for (const [cellKey, cell] of Object.entries(day.cells)) {
            const index = cellKey.indexOf("\u0000");
            if (
              index === -1 ||
              modelGroupKey(cellKey.slice(index + 1)) !== model
            )
              continue;
            const name = cellKey.slice(0, index);
            totals.set(name, addCell(bucketOf(totals, name), cell));
          }
        } else {
          for (const [name, cell] of Object.entries(day.byProject)) {
            totals.set(name, addCell(bucketOf(totals, name), cell));
          }
        }
      }
      const segments = Array.from(totals, ([name, cell]) => ({
        name,
        cell,
      }));
      daysOut.push({
        key,
        at,
        total: sumCells(segments.map((s) => s.cell)),
        segments,
      });
    }
    // 按模型和按项目都用同一套顺序：按全部天数的总词元从少到多排。
    // 柱子从上往下叠，总量最大的落在最下面。
    const rank = new Map<string, number>();
    for (const day of daysOut) {
      for (const segment of day.segments) {
        rank.set(
          segment.name,
          (rank.get(segment.name) ?? 0) + tokensOf(segment.cell),
        );
      }
    }
    for (const day of daysOut) {
      day.segments.sort(
        (a, b) => (rank.get(a.name) ?? 0) - (rank.get(b.name) ?? 0),
      );
    }
    const names = new Set<string>();
    for (const dayItem of daysOut)
      for (const segment of dayItem.segments) names.add(segment.name);
    return { days: daysOut, names: Array.from(names) };
  }, [view, days, project, model, todayStart]);

  const totals = useMemo(() => {
    const shown =
      view === "model" || view === "project"
        ? (dailyBreakdown?.days ?? []).map((day) => day.total)
        : view === "day"
          ? dayWeeks.flatMap((week) => week.days).map((day) => day.summary)
          : view === "week"
            ? weekBuckets.map((bucket) => bucket.summary)
            : monthBuckets.map((bucket) => bucket.summary);
    return totalsOf(sumCells(shown));
  }, [view, dailyBreakdown, dayWeeks, weekBuckets, monthBuckets]);

  const breakdownMaximum = useMemo(() => {
    if (dailyBreakdown === null) return 0;
    return Math.max(...dailyBreakdown.days.map((d) => tokensOf(d.total)), 0);
  }, [dailyBreakdown]);

  const dayMonthLabels = useMemo(() => {
    const labels: { left: number; text: string; index: number }[] = [];
    dayWeeks.forEach((week, index) => {
      const text = monthLabelFor(week.start);
      if (text !== undefined || index === 0) {
        labels.push({
          left: Math.min((index / 52) * 100, 94),
          text: text ?? `${new Date(week.start).getMonth() + 1}月`,
          index,
        });
      }
    });
    if (
      labels.length >= 2 &&
      (labels[1]?.index ?? 0) - (labels[0]?.index ?? 0) <= 1
    )
      labels.shift();
    return labels.map(({ left, text }) => ({ left, text }));
  }, [dayWeeks]);

  const weekMonthLabels = useMemo(() => {
    const labels: { left: number; text: string }[] = [];
    for (let column = 0; column < 4; column += 1) {
      const weeks = weekBuckets.slice(column * 4, column * 4 + 4);
      const first = weeks[0];
      if (first === undefined) continue;
      let text: string | undefined;
      for (const week of weeks) {
        const candidate = monthLabelFor(week.start);
        if (candidate !== undefined) {
          text = candidate;
          break;
        }
      }
      labels.push({
        left: (column / 4) * 100,
        text: text ?? `${new Date(first.start).getMonth() + 1}月`,
      });
    }
    return labels;
  }, [weekBuckets]);

  // 选中色块时显示该时段汇总，否则显示当前视图区间汇总。
  const shown = selected !== null ? totalsOf(selected.summary) : totals;

  const switchView = (next: View) => {
    setView(next);
    setSelected(null);
  };

  const DAY_CELL = 11;
  const DAY_GAP = 3;
  const WEEK_CELL = 26;
  const WEEK_GAP = 5;
  const MONTH_CELL = 26;
  const MONTH_GAP = 8;

  return (
    <section>
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h2
            style={{
              margin: 0,
              fontSize: 18,
              letterSpacing: "-0.02em",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span
              style={{
                width: 26,
                height: 26,
                display: "grid",
                placeItems: "center",
                borderRadius: 7,
                color: "var(--dsw-alias-state-success-primary)",
                background:
                  "color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)",
              }}
            >
              <IconDataOutline16 size={16} />
            </span>
            词元用量
          </h2>
          <p
            style={{
              margin: "6px 0 0",
              color: "var(--dsw-alias-label-tertiary)",
              fontSize: 12,
            }}
          >
            各模型供应商 · 历史按天聚合缓存 · 自动保存
          </p>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <FilterSelect
            label="项目"
            value={project}
            options={projects}
            onChange={(next) => {
              setProject(next);
              setSelected(null);
            }}
          />
          <FilterSelect
            label="模型"
            value={model}
            options={models}
            onChange={(next) => {
              setModel(next);
              setSelected(null);
            }}
          />
        </div>
      </header>

      {error ? (
        <p
          role="status"
          style={{
            color: "var(--dsw-alias-label-error)",
            fontSize: 12,
            margin: "14px 0 0",
          }}
        >
          {error}
        </p>
      ) : null}

      {selected !== null ? (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginTop: 18,
          }}
        >
          <strong style={{ fontSize: 13 }}>
            {fullLabel(selected.start, view)} 合计
          </strong>
          <button
            type="button"
            onClick={() => setSelected(null)}
            style={{
              border: 0,
              background: "none",
              padding: 0,
              color: "var(--dsw-alias-label-tertiary)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            取消选择
          </button>
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          marginTop: selected !== null ? 12 : 18,
        }}
      >
        <Metric
          icon={<IconDataOutline16 size={16} />}
          value={number(shown.tokens)}
          label="词元总数"
          hint={`${number(shown.calls)} 次模型调用`}
        />
        <Metric
          icon={<IconRightUpOutline16 size={16} />}
          value={`${number(shown.input + shown.cacheWrite)} / ${number(shown.output)}`}
          label="输入 / 输出"
          hint="未命中输入（含缓存写入）/ 输出"
        />
        <Metric
          icon={<IconGoalOutline16 size={16} />}
          value={number(shown.cacheRead)}
          label="缓存命中"
          hint={`缓存写入 ${number(shown.cacheWrite)}`}
        />
        <Metric
          icon={<IconListPenOutline16 size={16} />}
          value={money(shown.cost)}
          label="费用"
          hint={
            shown.peakCost > 0 || shown.offCost > 0
              ? `高峰 ${money(shown.peakCost)} · 闲时 ${money(shown.offCost)}`
              : "按 API 牌价估算（无峰谷差价）"
          }
        />
      </div>

      <div
        style={{
          marginTop: 18,
          border: "1px solid var(--dsw-alias-border-l2)",
          borderRadius: 12,
          background: "var(--dsw-alias-bg-layer-3)",
          padding: "16px 16px 14px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span
              title="当前连续天数"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                color: "var(--dsw-alias-label-secondary)",
                fontSize: 12,
              }}
            >
              <IconSparkle16 size={14} /> {metrics.current} 天
            </span>
            <span
              title="最长连续天数"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                color: "var(--dsw-alias-label-tertiary)",
                fontSize: 12,
              }}
            >
              <IconGoalOutline16 size={14} /> {metrics.longest} 天
            </span>
            <span
              title="单日峰值词元"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                color: "var(--dsw-alias-label-tertiary)",
                fontSize: 12,
              }}
            >
              <IconRightUpOutline16 size={14} /> {number(metrics.peakDay)}
            </span>
          </div>
          <div
            role="tablist"
            aria-label="统计粒度"
            style={{
              display: "inline-flex",
              padding: 3,
              border: "1px solid var(--dsw-alias-border-l2)",
              borderRadius: 9,
            }}
          >
            {(
              [
                ["day", "每日"],
                ["week", "每周"],
                ["month", "每月"],
                ["model", "按模型"],
                ["project", "按项目"],
              ] as const
            ).map(([id, text]) => (
              <button
                key={id}
                role="tab"
                aria-selected={view === id}
                onClick={() => switchView(id)}
                style={{
                  border: 0,
                  borderRadius: 6,
                  padding: "5px 11px",
                  cursor: "pointer",
                  font: "inherit",
                  fontSize: 12,
                  color: "inherit",
                  background:
                    view === id ? "var(--dsw-alias-bg-layer-2)" : "transparent",
                  boxShadow: view === id ? "0 1px 2px #00000012" : undefined,
                }}
              >
                {text}
              </button>
            ))}
          </div>
        </div>

        {view === "day" && (
          <div style={{ marginTop: 16 }}>
            <div style={{ display: "flex", gap: DAY_GAP }}>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: DAY_GAP,
                }}
              >
                {["一", "二", "三", "四", "五", "六", "日"].map(
                  (weekday, index) => (
                    <span
                      key={index}
                      style={{
                        height: DAY_CELL,
                        width: 12,
                        fontSize: 10,
                        lineHeight: `${DAY_CELL}px`,
                        textAlign: "center",
                        color: "var(--dsw-alias-label-tertiary)",
                      }}
                    >
                      {weekday}
                    </span>
                  ),
                )}
              </div>
              {dayWeeks.map((week) => (
                <div
                  key={week.start}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: DAY_GAP,
                  }}
                >
                  {week.days.map((day) => {
                    const tokens = tokensOf(day.summary);
                    const level = levelFromQuantile(tokens, dayLevels);
                    const interactive = !day.future;
                    return (
                      <button
                        key={day.at}
                        type="button"
                        disabled={!interactive}
                        title={`${fullLabel(day.at, "day")}：${number(tokens)} 词元，${money(day.summary.cost)}`}
                        onClick={() =>
                          setSelected({ start: day.at, summary: day.summary })
                        }
                        style={{
                          width: "100%",
                          height: DAY_CELL,
                          borderRadius: 3,
                          border: 0,
                          padding: 0,
                          background: cellColor(level),
                          cursor: interactive ? "pointer" : "default",
                          opacity: day.future ? 0.35 : 1,
                          outline:
                            selected?.start === day.at
                              ? "2px solid var(--dsw-alias-state-business-primary)"
                              : undefined,
                          outlineOffset: 1,
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
            <div
              style={{
                position: "relative",
                height: 15,
                marginTop: 3,
                marginLeft: 15,
              }}
            >
              {dayMonthLabels.map(({ left, text }) => (
                <span
                  key={text + left}
                  style={{
                    position: "absolute",
                    left: `${left}%`,
                    fontSize: 10,
                    color: "var(--dsw-alias-label-tertiary)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {text}
                </span>
              ))}
            </div>
          </div>
        )}

        {view === "week" && (
          <div style={{ marginTop: 16 }}>
            <div style={{ display: "flex", gap: WEEK_GAP }}>
              {[0, 1, 2, 3].map((column) => (
                <div
                  key={column}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: WEEK_GAP,
                  }}
                >
                  {weekBuckets
                    .slice(column * 4, column * 4 + 4)
                    .map((bucket) => {
                      const tokens = tokensOf(bucket.summary);
                      const level = levelFromQuantile(tokens, weekLevels);
                      return (
                        <button
                          key={bucket.start}
                          type="button"
                          title={`${fullLabel(bucket.start, "week")}：${number(tokens)} 词元，${money(bucket.summary.cost)}`}
                          onClick={() =>
                            setSelected({
                              start: bucket.start,
                              summary: bucket.summary,
                            })
                          }
                          style={{
                            width: "100%",
                            height: WEEK_CELL,
                            borderRadius: 4,
                            border: 0,
                            padding: 0,
                            background: cellColor(level),
                            cursor: "pointer",
                            outline:
                              selected?.start === bucket.start
                                ? "2px solid var(--dsw-alias-state-business-primary)"
                                : undefined,
                            outlineOffset: 1,
                          }}
                        />
                      );
                    })}
                </div>
              ))}
            </div>
            <div style={{ position: "relative", height: 15, marginTop: 3 }}>
              {weekMonthLabels.map(({ left, text }) => (
                <span
                  key={text + left}
                  style={{
                    position: "absolute",
                    left: `${left}%`,
                    fontSize: 10,
                    color: "var(--dsw-alias-label-tertiary)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {text}
                </span>
              ))}
            </div>
          </div>
        )}

        {view === "month" && (
          <div
            style={{
              marginTop: 16,
              display: "flex",
              flexWrap: "wrap",
              gap: MONTH_GAP,
              maxWidth: 6 * MONTH_CELL + 5 * MONTH_GAP,
            }}
          >
            {monthBuckets.map((bucket) => {
              const tokens = tokensOf(bucket.summary);
              const level = levelFromQuantile(tokens, monthLevels);
              return (
                <div
                  key={bucket.start}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 3,
                  }}
                >
                  <button
                    type="button"
                    title={`${fullLabel(bucket.start, "month")}：${number(tokens)} 词元，${money(bucket.summary.cost)}`}
                    onClick={() =>
                      setSelected({
                        start: bucket.start,
                        summary: bucket.summary,
                      })
                    }
                    style={{
                      width: MONTH_CELL,
                      height: MONTH_CELL,
                      borderRadius: 5,
                      border: 0,
                      padding: 0,
                      background: cellColor(level),
                      cursor: "pointer",
                      outline:
                        selected?.start === bucket.start
                          ? "2px solid var(--dsw-alias-state-business-primary)"
                          : undefined,
                      outlineOffset: 1,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 10,
                      color: "var(--dsw-alias-label-tertiary)",
                    }}
                  >
                    {new Date(bucket.start).getMonth() + 1}月
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {(view === "model" || view === "project") && dailyBreakdown !== null ? (
          <div
            style={{
              marginTop: 18,
              border: "1px solid var(--dsw-alias-border-l2)",
              borderRadius: 12,
              background: "var(--dsw-alias-bg-layer-3)",
              padding: "16px 16px 12px",
            }}
          >
            <DailyBars
              breakdown={dailyBreakdown}
              selected={selected}
              onSelect={setSelected}
            />
          </div>
        ) : null}

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 10,
            color: "var(--dsw-alias-label-tertiary)",
            fontSize: 11,
          }}
        >
          <span>
            {view === "day"
              ? label(dayWeeks[0]?.start ?? Date.now(), "day")
              : view === "week"
                ? label(weekBuckets[0]?.start ?? Date.now(), "week")
                : label(monthBuckets[0]?.start ?? Date.now(), "month")}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            用量低　
            {[0, 1, 2, 3, 4].map((level) => (
              <span
                key={level}
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 2,
                  background: cellColor(level),
                  display: "inline-block",
                }}
              />
            ))}
            　用量高
          </span>
          <span>
            {view === "day"
              ? label(dayWeeks.at(-1)?.start ?? Date.now(), "day")
              : view === "week"
                ? label(weekBuckets.at(-1)?.start ?? Date.now(), "week")
                : label(monthBuckets.at(-1)?.start ?? Date.now(), "month")}
          </span>
        </div>
      </div>

      <ProviderCards />

      {loading ? (
        <p
          style={{
            margin: "12px 0 0",
            color: "var(--dsw-alias-label-tertiary)",
            fontSize: 11,
            lineHeight: 1.55,
          }}
        >
          正在读取用量…
        </p>
      ) : null}
    </section>
  );
}

// ===== 供应商状态卡（DeepSeek 余额 + 峰谷；智谱套餐配额）=====

const PROVIDER_HEADER = { "x-dsh-config": "usage-calendar" };

interface BalanceItem {
  currency: string;
  total: number;
  granted: number;
  toppedUp: number;
}

interface DeepseekBalance {
  ok: boolean;
  reason?: string;
  isAvailable?: boolean;
  balances?: BalanceItem[];
}

interface QuotaWindow {
  label: string;
  used: number;
  total: number;
  remaining: number;
  pct: number;
  resetAt: number;
}

interface ZaiQuota {
  ok: boolean;
  reason?: string;
  level?: string;
  windows?: QuotaWindow[];
}

/** Copilot 一个配额窗口（与 host 侧 CopilotQuotaWindow 对应）。 */
interface CopilotQuotaWindow {
  id: string;
  entitlement: number;
  remaining: number;
  used: number;
  percentRemaining: number;
  unlimited: boolean;
  overagePermitted: boolean;
}

interface CopilotUsage {
  ok: boolean;
  reason?: string;
  plan?: string;
  sku?: string;
  resetDate?: string;
  quotas?: CopilotQuotaWindow[];
}

/** opencodex 限额（与宿主侧 OpencodexQuota 对应）。 */
interface OpencodexWindow {
  id: string;
  label: string;
  percent: number;
  resetAt: number;
}

interface OpencodexProviderQuota {
  provider: string;
  windows: OpencodexWindow[];
  extras: { label: string; percent: number; resetAt: number }[];
}

interface OpencodexQuota {
  ok: boolean;
  reason?: string;
  providers: OpencodexProviderQuota[];
}

/** 峰谷时段（北京时间 UTC+8：9:00-12:00、14:00-18:00 高峰）与下一边界倒计时。 */
function peakPhase(now = Date.now()): { peak: boolean; nextInMs: number } {
  const beijing = new Date(now + 8 * 3_600_000);
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  const peak =
    (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080);
  const boundaries = [540, 720, 840, 1080];
  const next = boundaries.find((b) => b > minutes) ?? 540 + 1440;
  return {
    peak,
    nextInMs: (next - minutes) * 60_000 - beijing.getUTCSeconds() * 1000,
  };
}

function countdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  if (days > 0) return `${days}天${hours}时${minutes}分`;
  if (hours > 0) return `${hours}时${minutes}分`;
  return `${minutes}分`;
}

function ProviderCards() {
  const [deepseek, setDeepseek] = useState<DeepseekBalance | null>(null);
  const [zai, setZai] = useState<ZaiQuota | null>(null);
  const [copilot, setCopilot] = useState<CopilotUsage | null>(null);
  const [opencodex, setOpencodex] = useState<OpencodexQuota | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    let stale = false;
    const pull = async () => {
      // 非 200（如宿主未重启时路由 404）也落失败态，不挂「读取中」。
      const json = async (url: string): Promise<unknown> => {
        try {
          const r = await fetch(url, { headers: PROVIDER_HEADER });
          if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
          return await r.json();
        } catch {
          return { ok: false, reason: "network" };
        }
      };
      const [d, z, c, o] = await Promise.all([
        json("/dsh-config/provider-status?kind=deepseek"),
        json("/dsh-config/provider-status?kind=zai"),
        json("/dsh-config/provider-status?kind=copilot"),
        json("/dsh-config/provider-status?kind=opencodex"),
      ]);
      if (stale) return;
      setDeepseek(d as DeepseekBalance | null);
      setZai(z as ZaiQuota | null);
      setCopilot(c as CopilotUsage | null);
      setOpencodex(o as OpencodexQuota | null);
    };
    void pull();
    const pullTimer = setInterval(() => void pull(), 60_000);
    // 倒计时/峰谷切换每 30 秒重算一次（不重新拉数据）。
    const tickTimer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => {
      stale = true;
      clearInterval(pullTimer);
      clearInterval(tickTimer);
    };
  }, []);

  return (
    <div
      style={{
        display: "flex",
        gap: 16,
        flexWrap: "nowrap",
        justifyContent: "space-between",
        alignItems: "flex-start",
        marginTop: 16,
      }}
    >
      <DeepseekBalanceCard data={deepseek} />
      <ZaiQuotaCard data={zai} />
      <OpencodexQuotaCard data={opencodex} />
      <CopilotUsageCard data={copilot} />
    </div>
  );
}

function CardFrame({
  label,
  children,
  grow = "1 1 0",
}: {
  label: string;
  children: ReactNode;
  /** flex 值：内容少的卡传 "0 1 auto" 按内容自然宽，避免右侧大片留白。 */
  grow?: string;
}) {
  return (
    // 三张套餐卡并排一行（容器 flex wrap 兜底窄屏），宽度分配由 grow 决定。
    <div style={{ flex: grow, minWidth: 0 }}>
      <div style={{ color: "var(--dsw-alias-label-tertiary)", fontSize: 12 }}>
        {label}
      </div>
      <div style={{ marginTop: 5, fontSize: 12, lineHeight: 1.7 }}>
        {children}
      </div>
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return (
    <span style={{ color: "var(--dsw-alias-label-tertiary)" }}>{children}</span>
  );
}

function DeepseekBalanceCard({ data }: { data: DeepseekBalance | null }) {
  if (data === null)
    return (
      <CardFrame label="DeepSeek 余额" grow="0 1 auto">
        <Muted>读取中…</Muted>
      </CardFrame>
    );
  if (!data.ok)
    return (
      <CardFrame label="DeepSeek 余额" grow="0 1 auto">
        <Muted>
          {data.reason === "unconfigured"
            ? "未配置 API 密钥"
            : `读取失败（${data.reason}）`}
        </Muted>
      </CardFrame>
    );
  const cny = data.balances?.find((b) => b.currency === "CNY");
  const usd = data.balances?.find((b) => b.currency === "USD");
  const phase = peakPhase();
  return (
    <CardFrame label="DeepSeek 余额" grow="0 1 auto">
      <strong
        style={{ fontSize: 18, letterSpacing: "-0.02em", display: "block" }}
      >
        {cny ? `¥${cny.total.toFixed(2)}` : "—"}
      </strong>
      <div style={{ color: "var(--dsw-alias-label-tertiary)", marginTop: 2 }}>
        {phase.peak ? "高峰时段" : "闲时时段"} · 距
        {phase.peak ? "闲时" : "高峰"} {countdown(phase.nextInMs)}
        {usd && usd.total > 0 ? ` · $${usd.total.toFixed(2)}` : ""}
        {cny && cny.granted > 0 ? ` · 赠金 ¥${cny.granted.toFixed(2)}` : ""}
      </div>
    </CardFrame>
  );
}

// ===== 限额圆环（5 小时窗口占上半环，周/月窗口占下半环）=====

/** 全部供应商卡统一的圆环尺寸。 */
export const RING_SIZE = 72;

/** 圆环的一个窗口：与宿主侧 OpencodexWindow 同形；used/total 有值时进悬停。 */
export interface RingWindow {
  id: string;
  label: string;
  percent: number;
  resetAt: number;
  /** 已用量（与 total 一起有值才展示「已用/总量」）。 */
  used?: number;
  /** 窗口总量。 */
  total?: number;
  /** 附加说明（如 cursor 的附加窗口、智谱峰谷），并入悬停提示。 */
  extraNote?: string;
  /** 接口未下发、仅为保持双环形态补的占位窗口。 */
  missing?: boolean;
}

export interface RingLayout {
  /** 上半环（5 小时窗口）；无 5 小时窗口时为 null（整环展示下半环）。 */
  top: RingWindow | null;
  /** 下半环；只有单一窗口时它占整环。 */
  bottom: RingWindow;
  /** true = 单一窗口整环；false = 上 5 小时 + 下周/月双半环。 */
  fullCircle: boolean;
}

/** 布局决策（测试出口）：有 5 小时窗口就上/下半环，否则单一窗口占整环。 */
export function ringLayout(windows: readonly RingWindow[]): RingLayout | null {
  const usable = windows.filter((w) => Number.isFinite(w.percent));
  if (usable.length === 0) return null;
  const fiveHour = usable.find((w) => w.id === "fiveHour");
  if (fiveHour === undefined) {
    const window = usable[0]!;
    return { top: null, bottom: window, fullCircle: true };
  }
  const rest = usable.find((w) => w !== fiveHour);
  if (rest === undefined)
    return { top: null, bottom: fiveHour, fullCircle: true };
  return { top: fiveHour, bottom: rest, fullCircle: false };
}

/** 已用百分比对应的窗口色：剩余越少越红（与既有进度条口径一致）。 */
function ringColor(percent: number): string {
  const remain = 100 - percent;
  if (remain <= 20) return "var(--dsw-alias-state-error-primary)";
  if (remain <= 50) return "var(--dsw-alias-state-warn-primary)";
  return "var(--dsw-alias-state-success-primary)";
}

/**
 * 单窗口的悬停提示（测试出口），逐行：指标名 / 已用（/总量）/ 重置时间 /
 * 附加说明。浮窗首行加粗作标题。
 */
export function windowTitle(window: RingWindow): string {
  const extra = window.extraNote ? `\n${window.extraNote}` : "";
  if (window.missing === true)
    return `${window.label}\n接口未下发该窗口（按 0% 占位）${extra}`;
  const used =
    typeof window.used === "number" &&
    typeof window.total === "number" &&
    window.total > 0
      ? `已用 ${cnDigits(window.used)} / ${cnDigits(window.total)}（${Math.round(window.percent)}%）`
      : `已用 ${Math.round(window.percent)}%`;
  const reset =
    window.resetAt > 0
      ? `${countdown(window.resetAt - Date.now())}后重置`
      : "重置时间未知";
  return `${window.label}\n${used}\n${reset}${extra}`;
}

/**
 * 半圆弧路径：上下两段在左右两端各留竖向间隙。端点取 ±12°（水平线
 * 上下 38·sin12° ≈ 7.9），扣掉圆头线帽各 4.5 后仍有约 6.8 单位
 * （72px 渲染时约 5px）的净间隙；底轨同样分两段画，间隙不会被底轨填平。
 */
export const RING_TOP_ARC = "M 12.83 42.1 A 38 38 0 0 1 87.17 42.1";
export const RING_BOTTOM_ARC = "M 12.83 57.9 A 38 38 0 0 0 87.17 57.9";

/** 悬停命中的环带范围（viewBox 单位，环心在 50,50，弧线半径 38、粗 9）。 */
export const RING_HIT_INNER = 26;
export const RING_HIT_OUTER = 55;

/**
 * 悬停命中判定（测试出口）：光标相对圆环中心的像素偏移 + 渲染尺寸 →
 * 命中上半环 / 下半环 / 不命中（环心数字区与环外）。整环时恒为 bottom。
 */
export function ringHit(
  dx: number,
  dy: number,
  size: number,
  hasTop: boolean,
): "top" | "bottom" | null {
  const distance = Math.hypot(dx, dy) * (100 / size);
  if (distance < RING_HIT_INNER || distance > RING_HIT_OUTER) return null;
  return hasTop && dy < 0 ? "top" : "bottom";
}

/** 灰环占位（读取中 / 失败 / 未配置）：中心短词 + 悬停说明。 */
export interface RingPlaceholder {
  center: string;
  tip: string;
}

const LOADING_RING: RingPlaceholder = { center: "读取中", tip: "正在读取配额…" };

function failedRing(
  reason: string | undefined,
  unconfigured: string,
): RingPlaceholder {
  return reason === "unconfigured"
    ? { center: "未配置", tip: unconfigured }
    : { center: "不可用", tip: `读取失败（${reason ?? "未知原因"}）` };
}

/**
 * 跟随光标的浮窗：portal 到 body（逃出弹窗 overflow 裁剪与任何变换
 * 祖先），zIndex 1100 盖过用量弹窗（1000）；贴近视口右/下边时翻到光标另一侧。
 */
function RingTip({ text, x, y }: { text: string; x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    let left = x + 14;
    let top = y + 16;
    if (left + width > window.innerWidth - 8)
      left = Math.max(8, x - 14 - width);
    if (top + height > window.innerHeight - 8)
      top = Math.max(8, y - 12 - height);
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }, [text, x, y]);
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      style={{
        position: "fixed",
        left: x + 14,
        top: y + 16,
        zIndex: 1100,
        // 定宽于内容：贴近视口右缘时 fixed 元素会被压窄换行，量出的宽度
        // 不准就翻转不了。
        width: "max-content",
        maxWidth: 300,
        boxSizing: "border-box",
        padding: "7px 10px",
        borderRadius: 8,
        border: "1px solid var(--dsw-alias-border-inverted)",
        background: "var(--dsw-alias-bg-layer-2)",
        boxShadow: "var(--dsw-shadow-lv3)",
        color: "var(--dsw-alias-label-primary)",
        fontSize: 12,
        lineHeight: 1.6,
        whiteSpace: "pre-line",
        pointerEvents: "none",
        textAlign: "left",
      }}
    >
      <div style={{ fontWeight: 600 }}>{text.split("\n")[0]}</div>
      {text.split("\n").slice(1).join("\n")}
    </div>,
    document.body,
  );
}

function QuotaRing({
  windows,
  size = RING_SIZE,
  note,
  placeholder,
  centerColor,
}: {
  windows: readonly RingWindow[];
  size?: number;
  /** 环下最简标注（供应商名），不再放其他文字。 */
  note: string;
  /** 灰环占位：读取中 / 失败 / 未配置 / 无数据。 */
  placeholder?: RingPlaceholder;
  /** 中心数字颜色（智谱用它表示峰谷）；默认常规文字色。 */
  centerColor?: string;
}) {
  const layout = placeholder === undefined ? ringLayout(windows) : null;
  const shown: RingPlaceholder | undefined =
    placeholder ??
    (layout === null ? { center: "—", tip: "暂无配额数据" } : undefined);
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(
    null,
  );
  const tipShown = tip !== null;
  // 滚动时光标不动但圆环移走了：收起浮窗，等下一次移动重新判定。
  useEffect(() => {
    if (!tipShown) return;
    const hide = () => setTip(null);
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  }, [tipShown]);
  // 命中判定挂在圆环外层方块上（中心数字层 pointer-events 关闭，不再挡住
  // 事件），按极坐标取环带、按上下半区选指标；环心与环外收起浮窗。
  const onMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const half = ringHit(
      event.clientX - (rect.left + rect.width / 2),
      event.clientY - (rect.top + rect.height / 2),
      rect.width,
      layout?.top != null,
    );
    if (half === null) {
      setTip(null);
      return;
    }
    // 首行带上厂商名：浮窗可能盖住环下标注。
    const text =
      layout === null
        ? `${note}\n${shown?.tip ?? ""}`
        : `${note} · ${windowTitle(half === "top" ? layout.top! : layout.bottom)}`;
    setTip({ text, x: event.clientX, y: event.clientY });
  };
  const track = (d: string) => (
    <path
      d={d}
      fill="none"
      stroke="var(--dsw-alias-interactive-bg-hover)"
      strokeWidth="9"
      strokeLinecap="round"
    />
  );
  const arc = (d: string, percent: number) => (
    <path
      d={d}
      fill="none"
      stroke={ringColor(percent)}
      strokeWidth="9"
      strokeLinecap="round"
      pathLength={100}
      strokeDasharray={`${Math.max(percent, 2)} 100`}
    />
  );
  let rings: ReactNode;
  if (layout === null || layout.fullCircle) {
    rings = (
      <>
        <circle
          cx="50"
          cy="50"
          r="38"
          fill="none"
          stroke="var(--dsw-alias-interactive-bg-hover)"
          strokeWidth="9"
        />
        {layout !== null ? (
          <circle
            cx="50"
            cy="50"
            r="38"
            fill="none"
            stroke={ringColor(layout.bottom.percent)}
            strokeWidth="9"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${Math.max(layout.bottom.percent, 1.5)} 100`}
            transform="rotate(-90 50 50)"
          />
        ) : null}
      </>
    );
  } else {
    rings = (
      <>
        {track(RING_TOP_ARC)}
        {track(RING_BOTTOM_ARC)}
        {arc(RING_TOP_ARC, layout.top!.percent)}
        {arc(RING_BOTTOM_ARC, layout.bottom.percent)}
      </>
    );
  }
  return (
    <div
      style={{ width: size, flex: "none", textAlign: "center" }}
      role="img"
      aria-label={
        layout !== null
          ? `${note}：${layout.top ? `${layout.top.label} ${Math.round(layout.top.percent)}%、` : ""}${layout.bottom.label} ${Math.round(layout.bottom.percent)}%`
          : `${note}：${shown?.tip ?? ""}`
      }
    >
      <div
        style={{ position: "relative", width: size, height: size }}
        onMouseMove={onMove}
        onMouseLeave={() => setTip(null)}
      >
        <svg
          width={size}
          height={size}
          viewBox="0 0 100 100"
          style={{ display: "block" }}
        >
          {rings}
        </svg>
        <span
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            fontSize: Math.round(size * (layout === null ? 0.16 : 0.22)),
            fontWeight: layout === null ? 500 : 700,
            letterSpacing: "-0.02em",
            color:
              layout === null
                ? "var(--dsw-alias-label-tertiary)"
                : (centerColor ?? "var(--dsw-alias-label-primary)"),
          }}
        >
          {layout === null
            ? shown?.center
            : `${Math.round(layout.bottom.percent)}%`}
        </span>
      </div>
      <div
        style={{
          fontSize: 11,
          marginTop: 3,
          color: "var(--dsw-alias-label-secondary)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {note}
      </div>
      {tip !== null ? <RingTip text={tip.text} x={tip.x} y={tip.y} /> : null}
    </div>
  );
}

/** 多个圆环并排（opencodex 三家、copilot 多窗口）。 */
function RingRow({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", gap: 18 }}>{children}</div>;
}

/** 智谱峰谷相位：周一至周五 14:00-18:00（UTC+8）高峰，其余闲时（积分 5 折）。 */
function zaiPhase(now = Date.now()): { peak: boolean } {
  const beijing = new Date(now + 8 * 3_600_000);
  const day = beijing.getUTCDay();
  const hour = beijing.getUTCHours();
  return { peak: day >= 1 && day <= 5 && hour >= 14 && hour < 18 };
}

/** 智谱窗口标签（「5时」「周」「2w」…）到圆环窗口 id 与指标名（测试出口）。 */
export function zaiWindowKind(label: string): { id: string; label: string } {
  if (/时$/.test(label))
    return label === "5时"
      ? { id: "fiveHour", label: "5小时限额" }
      : { id: "fiveHour", label: `${label.replace(/时$/, "")}小时限额` };
  if (label === "周") return { id: "weekly", label: "本周限额" };
  if (/^\d+w$/.test(label))
    return { id: "weekly", label: `${label.replace(/w$/, "")}周限额` };
  return { id: label, label: `${label}限额` };
}

/** 智谱峰谷：中心数字颜色（高峰橙、闲时绿）+ 悬停说明（测试出口）。 */
export function zaiPeakStyle(peak: boolean): { color: string; note: string } {
  return peak
    ? {
        color: "var(--dsw-alias-state-warn-primary)",
        note: "当前高峰时段（中心数字橙色）：积分全额抵扣",
      }
    : {
        color: "var(--dsw-alias-state-success-primary)",
        note: "当前闲时（中心数字绿色）：积分 5 折抵扣",
      };
}

function ZaiQuotaCard({ data }: { data: ZaiQuota | null }) {
  if (data === null)
    return <QuotaRing windows={[]} note="智谱" placeholder={LOADING_RING} />;
  if (!data.ok)
    return (
      <QuotaRing
        windows={[]}
        note="智谱"
        placeholder={failedRing(data.reason, "未配置 API 密钥")}
      />
    );
  const peak = zaiPeakStyle(zaiPhase().peak);
  const ringWindows: RingWindow[] = (data.windows ?? []).map((w) => ({
    ...zaiWindowKind(w.label),
    percent: w.pct,
    resetAt: w.resetAt,
    ...(w.total > 0 ? { used: w.used, total: w.total } : {}),
    extraNote: peak.note,
  }));
  // 5 小时窗口未下发时补一个 0% 占位，保证双环形态（上 5h 下周）。
  if (ringWindows.length > 0 && !ringWindows.some((w) => w.id === "fiveHour"))
    ringWindows.unshift({
      id: "fiveHour",
      label: "5小时限额",
      percent: 0,
      resetAt: 0,
      missing: true,
      extraNote: peak.note,
    });
  return (
    <QuotaRing
      windows={ringWindows}
      note={`智谱${data.level ? ` · ${data.level}` : ""}`}
      centerColor={peak.color}
    />
  );
}

const OPENCODEX_PROVIDERS = ["anthropic", "openai", "cursor"];
const OPENCODEX_LABELS: Record<string, string> = {
  anthropic: "Claude",
  openai: "ChatGPT",
  cursor: "Cursor",
};

/** opencodex 限额卡：anthropic / openai / cursor 各一个圆环，说明进悬停。 */
function OpencodexQuotaCard({ data }: { data: OpencodexQuota | null }) {
  const placeholders = (placeholder: RingPlaceholder) => (
    <RingRow>
      {OPENCODEX_PROVIDERS.map((provider) => (
        <QuotaRing
          key={provider}
          windows={[]}
          note={OPENCODEX_LABELS[provider]!}
          placeholder={placeholder}
        />
      ))}
    </RingRow>
  );
  if (data === null) return placeholders(LOADING_RING);
  // 旧版宿主没有 kind=opencodex 分支会落 DeepSeek 余额结构。
  if ((data as { balances?: unknown }).balances !== undefined)
    return placeholders({ center: "—", tip: "宿主需重启加载新版后显示" });
  if (!data.ok)
    return placeholders(
      data.reason === "cli"
        ? { center: "不可用", tip: "opencodex 命令不可用（未安装或执行失败）" }
        : data.reason === "parse"
          ? { center: "不可用", tip: "opencodex 配额输出无法解析" }
          : failedRing(data.reason, "opencodex 未配置"),
    );
  if (data.providers.length === 0)
    return (
      <QuotaRing
        windows={[]}
        note="opencodex"
        placeholder={{ center: "未配置", tip: "opencodex 未配置供应商" }}
      />
    );
  // cursor 的附加窗口并入下半环（整环）的悬停提示，不占卡面。
  const extrasNote = (provider: OpencodexProviderQuota): string =>
    provider.extras
      .map((extra) => `${extra.label}：已用 ${Math.round(extra.percent)}%`)
      .join("\n");
  const providers = [...data.providers].sort(
    (a, b) =>
      OPENCODEX_PROVIDERS.indexOf(a.provider) -
      OPENCODEX_PROVIDERS.indexOf(b.provider),
  );
  return (
    <RingRow>
      {providers.map((provider) => (
        <QuotaRing
          key={provider.provider}
          note={OPENCODEX_LABELS[provider.provider] ?? provider.provider}
          windows={provider.windows.map((w) => ({
            ...w,
            label: `${w.label}限额`,
            ...(provider.extras.length > 0 && w.id !== "fiveHour"
              ? { extraNote: extrasNote(provider) }
              : {}),
          }))}
        />
      ))}
    </RingRow>
  );
}

/** Copilot 配额窗口的中文标签（环下最简标注 + 悬停完整说明）。 */
function copilotWindowLabel(id: string): string {
  if (id === "premium_interactions") return "积分";
  if (id === "chat") return "对话";
  if (id === "completions") return "补全";
  return id;
}

/** Copilot 套餐档中文名（未知档显示原值）。 */
function copilotPlanLabel(plan: string): string {
  const known: Record<string, string> = {
    individual: "个人版",
    business: "商业版",
    enterprise: "企业版",
    free: "免费版",
  };
  return known[plan] ?? plan;
}

/** 配额重置日（ISO 日期）到重置时刻（epoch ms，未知为 0）。 */
function resetEpoch(resetDate: string | undefined): number {
  if (resetDate === undefined) return 0;
  const start = new Date(`${resetDate}T00:00:00`).getTime();
  return Number.isNaN(start) ? 0 : start;
}

function CopilotUsageCard({ data }: { data: CopilotUsage | null }) {
  if (data === null)
    return <QuotaRing windows={[]} note="Copilot" placeholder={LOADING_RING} />;
  if (!data.ok)
    return (
      <QuotaRing
        windows={[]}
        note="Copilot"
        placeholder={failedRing(data.reason, "未登录 GitHub Copilot")}
      />
    );
  // 旧版宿主没有 kind=copilot 分支，会落 DeepSeek 余额（balances 字段）：
  // 此时不是「无配额」，而是宿主还没加载新代码。
  if ((data as { balances?: unknown }).balances !== undefined)
    return (
      <QuotaRing
        windows={[]}
        note="Copilot"
        placeholder={{ center: "—", tip: "宿主需重启加载新版后显示" }}
      />
    );
  const plan = data.plan ? copilotPlanLabel(data.plan) : undefined;
  // 无限额度（对话/补全）没有可展示的余量，不渲染环；只显示有限额度窗口。
  const windows = (data.quotas ?? []).filter((w) => !w.unlimited);
  if (windows.length === 0)
    return (
      <QuotaRing
        windows={[]}
        note="Copilot"
        placeholder={{
          center: "不限量",
          tip: `${plan ? `${plan}：` : ""}对话与补全不限量，无有限额度窗口`,
        }}
      />
    );
  return (
    <RingRow>
      {windows.map((w) => {
        const label = copilotWindowLabel(w.id);
        const used = Math.max(0, w.entitlement - w.remaining);
        return (
          <QuotaRing
            key={w.id}
            note={windows.length === 1 ? "Copilot" : `Copilot ${label}`}
            windows={[
              {
                id: w.id,
                label: `${label}限额`,
                percent: 100 - w.percentRemaining,
                resetAt: resetEpoch(data.resetDate),
                ...(w.entitlement > 0 ? { used, total: w.entitlement } : {}),
                ...(plan ? { extraNote: `套餐：${plan}` } : {}),
              },
            ]}
          />
        );
      })}
    </RingRow>
  );
}

// ===== 按模型 / 按项目视图：每日堆叠柱状图 =====

function bucketOf(map: Map<string, CellSummary>, name: string): CellSummary {
  const existing = map.get(name);
  if (existing !== undefined) return existing;
  const fresh = emptySummary();
  map.set(name, fresh);
  return fresh;
}

const BAR_PALETTE = [
  "var(--dsw-alias-state-success-primary)",
  "var(--dsw-alias-state-business-primary)",
  "var(--dsw-alias-state-warn-primary)",
  "var(--dsw-alias-state-error-primary)",
  "var(--dsw-alias-state-idle-primary)",
  "var(--dsw-alias-label-primary-bluish)",
  "var(--dsw-alias-label-secondary)",
  "var(--dsw-alias-label-tertiary)",
];

function segmentColor(name: string, names: string[]): string {
  const sorted = [...names].sort();
  const index = Math.max(0, sorted.indexOf(name)) % BAR_PALETTE.length;
  return BAR_PALETTE[index] ?? BAR_PALETTE[0]!;
}

function DailyBars({
  breakdown,
  onSelect,
  selected,
}: {
  breakdown: {
    days: {
      key: string;
      at: number;
      total: CellSummary;
      segments: { name: string; cell: CellSummary }[];
    }[];
    names: string[];
  };
  onSelect: (entry: { start: number; summary: CellSummary }) => void;
  selected: { start: number; summary: CellSummary } | null;
}) {
  const maximum = Math.max(
    ...breakdown.days.map((day) => tokensOf(day.total)),
    0,
  );
  const [hover, setHover] = useState<string | null>(null);
  const dimmed = (name: string): boolean => hover !== null && hover !== name;
  return (
    <div>
      <div
        style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 10 }}
      >
        {breakdown.names.map((name) => (
          <span
            key={name}
            onMouseEnter={() => setHover(name)}
            onMouseLeave={() => setHover(null)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11,
              cursor: "pointer",
              color:
                hover === name
                  ? "var(--dsw-alias-label-primary)"
                  : "var(--dsw-alias-label-secondary)",
              opacity: dimmed(name) ? 0.35 : 1,
            }}
          >
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: 2,
                background: segmentColor(name, breakdown.names),
                display: "inline-block",
              }}
            />
            {name}
          </span>
        ))}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 3,
          height: 140,
          padding: "6px 2px 0",
        }}
      >
        {breakdown.days.map((day) => {
          const tokens = tokensOf(day.total);
          const height = maximum > 0 ? Math.round((tokens / maximum) * 100) : 0;
          const isSelected = selected !== null && selected.start === day.at;
          const title = [
            fullLabel(day.at, "day"),
            `${number(tokens)} 词元 · ${number(day.total.calls)} 次`,
            ...day.segments.map(
              (s) => `${s.name}: ${number(tokensOf(s.cell))}`,
            ),
          ].join("\n");
          return (
            <div
              key={day.key}
              title={title}
              onClick={() => onSelect({ start: day.at, summary: day.total })}
              style={{
                flex: 1,
                height: "100%",
                display: "flex",
                flexDirection: "column",
                justifyContent: "flex-end",
                cursor: "pointer",
                minWidth: 0,
              }}
            >
              <div
                style={{
                  height: `${height}%`,
                  minHeight: tokens > 0 ? 2 : 0,
                  borderRadius: 3,
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                  outline: isSelected
                    ? "2px solid var(--dsw-alias-label-primary-bluish)"
                    : undefined,
                  outlineOffset: 1,
                }}
              >
                {day.segments.map((segment) => {
                  const share =
                    tokens > 0 ? tokensOf(segment.cell) / tokens : 0;
                  return (
                    <div
                      key={segment.name}
                      onMouseEnter={() => setHover(segment.name)}
                      onMouseLeave={() => setHover(null)}
                      style={{
                        flex: `${share * 100}%`,
                        background: segmentColor(segment.name, breakdown.names),
                        opacity: dimmed(segment.name) ? 0.18 : 1,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          gap: 3,
          marginTop: 4,
          fontSize: 10,
          color: "var(--dsw-alias-label-tertiary)",
        }}
      >
        {breakdown.days.map((day, index) => (
          <div
            key={day.key}
            style={{ flex: 1, textAlign: "center", minWidth: 0 }}
          >
            {index % 5 === 0 || index === breakdown.days.length - 1
              ? new Date(day.at).toLocaleDateString("zh-CN", {
                  month: "numeric",
                  day: "numeric",
                })
              : ""}
          </div>
        ))}
      </div>
    </div>
  );
}
