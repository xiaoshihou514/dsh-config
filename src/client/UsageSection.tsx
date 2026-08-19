import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  IconDataOutline16,
  IconGoalOutline16,
  IconListPenOutline16,
  IconRightUpOutline16,
  IconSparkle16,
} from "./icons.tsx";

type View = "day" | "week" | "month";
type Model = "deepseek-v4-flash" | "deepseek-v4-pro";

interface RecordItem {
  id: string;
  at: number;
  project: string;
  model: Model;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** 一档单价：高峰 / 闲时（元 / 百万 tokens）。 */
interface Tier {
  peak: number;
  off: number;
}

interface Price {
  hit: Tier;
  miss: Tier;
  output: Tier;
}

interface Totals {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  peakCost: number;
  offCost: number;
}

/** DeepSeek 官方 2026-08-17 起生效的峰谷单价（元 / 百万 tokens）。 */
const price: Record<Model, Price> = {
  "deepseek-v4-flash": {
    hit: { peak: 0.1, off: 0.05 },
    miss: { peak: 3, off: 1.5 },
    output: { peak: 9, off: 4.5 },
  },
  "deepseek-v4-pro": {
    hit: { peak: 0.3, off: 0.15 },
    miss: { peak: 9, off: 4.5 },
    output: { peak: 27, off: 13.5 },
  },
};

/**
 * 高峰时段按北京时间（UTC+8，无夏令时）判定：9:00-12:00、14:00-18:00 为高峰。
 */
function isPeak(time: number): boolean {
  const hour = new Date(time + 8 * 3_600_000).getUTCHours();
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/** 单条记录的估算费用（元），按自身发生时间取高峰或闲时单价。 */
function costOf(record: RecordItem): number {
  const unit = price[record.model];
  const tier = isPeak(record.at) ? "peak" : "off";
  return (
    (record.cacheReadTokens * unit.hit[tier] +
      (record.inputTokens + record.cacheWriteTokens) * unit.miss[tier] +
      record.outputTokens * unit.output[tier]) /
    1_000_000
  );
}

function total(records: readonly RecordItem[]): Totals {
  return records.reduce<Totals>(
    (sum, record) => {
      const cost = costOf(record);
      return {
        calls: sum.calls + 1,
        input: sum.input + record.inputTokens,
        output: sum.output + record.outputTokens,
        cacheRead: sum.cacheRead + record.cacheReadTokens,
        cacheWrite: sum.cacheWrite + record.cacheWriteTokens,
        cost: sum.cost + cost,
        peakCost: sum.peakCost + (isPeak(record.at) ? cost : 0),
        offCost: sum.offCost + (isPeak(record.at) ? 0 : cost),
      };
    },
    {
      calls: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      peakCost: 0,
      offCost: 0,
    },
  );
}

function tokensOf(records: readonly RecordItem[]): number {
  return records.reduce(
    (sum, record) =>
      sum +
      record.inputTokens +
      record.outputTokens +
      record.cacheReadTokens +
      record.cacheWriteTokens,
    0,
  );
}

const DAY = 86_400_000;

function dayStart(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
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

function money(value: number): string {
  return `¥${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
}

function dayKey(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isNextDay(a: string, b: string): boolean {
  return (
    new Date(`${b}T00:00:00`).getTime() -
      new Date(`${a}T00:00:00`).getTime() ===
    DAY
  );
}

/** 连续使用天数：当前连续（截至最近有记录的一天）与历史最长连续。 */
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

/** 若该周（以周一开头）内出现某月的 1 号，返回该月的月份标签（GitHub 式）。 */
function monthLabelFor(weekStart: number): string | undefined {
  const monday = new Date(weekStart);
  const firstOfMonth = new Date(
    monday.getFullYear(),
    monday.getMonth(),
    1,
  ).getTime();
  return firstOfMonth >= weekStart && firstOfMonth < weekStart + 7 * DAY
    ? `${monday.getMonth() + 1}月`
    : undefined;
}

/** 热力等级：0-4，按 token 量与区间最大值占比。 */
function levelOf(value: number, maximum: number): number {
  if (value <= 0 || maximum <= 0) return 0;
  const ratio = value / maximum;
  return Math.min(4, Math.max(1, Math.ceil(ratio * 4)));
}

/** 热力色：0 级为底色，1-4 级把主题成功色按比例混入底色，随明暗主题自适应。 */
function cellColor(level: number): string {
  const base = "var(--dsw-alias-bg-layer-2)";
  if (level === 0) return base;
  const mix = [30, 55, 80, 100][level - 1] ?? 100;
  return `color-mix(in srgb, var(--dsw-alias-state-success-primary) ${mix}%, ${base})`;
}

function Metric({
  icon,
  value,
  label: text,
}: {
  icon: ReactNode;
  value: string;
  label: string;
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
    </div>
  );
}

function Summary({
  label: title,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ color: "var(--dsw-alias-label-tertiary)", fontSize: 12 }}>
        {title}
      </div>
      <strong
        style={{
          display: "block",
          marginTop: 4,
          fontSize: 18,
          letterSpacing: "-0.02em",
        }}
      >
        {value}
      </strong>
      <div
        style={{
          color: "var(--dsw-alias-label-tertiary)",
          fontSize: 11,
          marginTop: 2,
        }}
      >
        {hint}
      </div>
    </div>
  );
}

interface DayCell {
  at: number;
  records: RecordItem[];
  tokens: number;
  cost: number;
  future: boolean;
}

interface Bucket {
  start: number;
  records: RecordItem[];
}

export function UsageSection() {
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [view, setView] = useState<View>("day");
  const [project, setProject] = useState("全部项目");
  const [model, setModel] = useState("全部模型");
  const [selected, setSelected] = useState<Bucket | null>(null);
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
        const payload = (await response.json()) as {
          ok?: boolean;
          records?: RecordItem[];
        };
        if (!response.ok || !payload.ok || !Array.isArray(payload.records))
          throw new Error("读取用量数据失败");
        const nextEtag = response.headers.get("etag");
        if (!stale) {
          if (nextEtag !== null) etagRef.current = nextEtag;
          setRecords(payload.records);
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

  const projects = useMemo(
    () => [
      "全部项目",
      ...Array.from(new Set(records.map((record) => record.project))).sort(),
    ],
    [records],
  );
  const models = useMemo(
    () => [
      "全部模型",
      ...Array.from(new Set(records.map((record) => record.model))).sort(),
    ],
    [records],
  );
  const filtered = useMemo(
    () =>
      records.filter(
        (record) =>
          (project === "全部项目" || record.project === project) &&
          (model === "全部模型" || record.model === model),
      ),
    [project, model, records],
  );

  const todayStart = useMemo(() => dayStart(Date.now()), []);
  const thisMonday = useMemo(() => mondayOf(todayStart), [todayStart]);

  // 一次遍历建立「日 → 记录/汇总」索引：格子与周/月分桶全部 O(1) 查表，
  // 替代原先每个格子对全部记录 filter（records × 364 次扫描）。
  const byDay = useMemo(() => {
    const map = new Map<
      number,
      { records: RecordItem[]; tokens: number; cost: number }
    >();
    for (const record of filtered) {
      const at = dayStart(record.at);
      let entry = map.get(at);
      if (entry === undefined) {
        entry = { records: [], tokens: 0, cost: 0 };
        map.set(at, entry);
      }
      entry.records.push(record);
      entry.tokens +=
        record.inputTokens +
        record.outputTokens +
        record.cacheReadTokens +
        record.cacheWriteTokens;
      entry.cost += costOf(record);
    }
    return map;
  }, [filtered]);

  const dayWeeks = useMemo(() => {
    const weeks: { start: number; days: DayCell[] }[] = [];
    for (let week = 51; week >= 0; week -= 1) {
      const start = thisMonday - week * 7 * DAY;
      const days: DayCell[] = [];
      for (let offset = 0; offset < 7; offset += 1) {
        const at = start + offset * DAY;
        const entry = byDay.get(at);
        days.push({
          at,
          future: at > todayStart,
          records: entry?.records ?? [],
          tokens: entry?.tokens ?? 0,
          cost: entry?.cost ?? 0,
        });
      }
      weeks.push({ start, days });
    }
    return weeks;
  }, [byDay, thisMonday, todayStart]);

  const weekBuckets = useMemo(() => {
    const buckets: Bucket[] = [];
    for (let week = 15; week >= 0; week -= 1) {
      const start = thisMonday - week * 7 * DAY;
      const records: RecordItem[] = [];
      for (const [at, entry] of byDay) {
        if (at >= start && at < start + 7 * DAY) records.push(...entry.records);
      }
      buckets.push({ start, records });
    }
    return buckets;
  }, [byDay, thisMonday]);

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
      const records: RecordItem[] = [];
      for (const [at, entry] of byDay) {
        if (at >= start && at < end) records.push(...entry.records);
      }
      buckets.push({ start, records });
    }
    return buckets;
  }, [byDay, todayStart]);

  const displayed = useMemo(
    () =>
      view === "day"
        ? dayWeeks.flatMap((week) => week.days).flatMap((day) => day.records)
        : view === "week"
          ? weekBuckets.flatMap((bucket) => bucket.records)
          : monthBuckets.flatMap((bucket) => bucket.records),
    [view, dayWeeks, weekBuckets, monthBuckets],
  );
  const totals = useMemo(() => total(displayed), [displayed]);
  const allTime = useMemo(() => total(filtered), [filtered]);

  const metrics = useMemo(() => {
    const all = total(filtered);
    const dayTotals = new Map<string, number>();
    for (const record of filtered) {
      const key = dayKey(record.at);
      dayTotals.set(
        key,
        (dayTotals.get(key) ?? 0) +
          record.inputTokens +
          record.outputTokens +
          record.cacheReadTokens +
          record.cacheWriteTokens,
      );
    }
    const { current, longest } = streaks(Array.from(dayTotals.keys()));
    return {
      tokens: all.input + all.output + all.cacheRead + all.cacheWrite,
      peakDay: Math.max(...dayTotals.values(), 0),
      cost: all.cost,
      current,
      longest,
    };
  }, [filtered]);

  const dayMaximum = useMemo(
    () =>
      Math.max(
        ...dayWeeks.flatMap((week) => week.days).map((day) => day.tokens),
        0,
      ),
    [dayWeeks],
  );
  const weekMaximum = useMemo(
    () => Math.max(...weekBuckets.map((bucket) => tokensOf(bucket.records)), 0),
    [weekBuckets],
  );
  const monthMaximum = useMemo(
    () =>
      Math.max(...monthBuckets.map((bucket) => tokensOf(bucket.records)), 0),
    [monthBuckets],
  );

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
    // 首列的强制标签与紧邻的月份起始标签间距不足一个标签宽时会重叠
    // （渲染成「8月月」）：间隔 ≤1 列就去掉强制标签。
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

  const selectedTotals = useMemo(
    () => (selected === null ? null : total(selected.records)),
    [selected],
  );
  // 选中色块时下方汇总显示该时段数据，否则显示当前视图区间。
  const shown = selectedTotals ?? totals;

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
            仅统计 DeepSeek 官方模型 · 自动保存
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
          <label
            style={{ fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}
          >
            项目　
            <select
              value={project}
              onChange={(event) => {
                setProject(event.target.value);
                setSelected(null);
              }}
              style={{
                color: "inherit",
                background: "transparent",
                border: "1px solid var(--dsw-alias-border-l2)",
                borderRadius: 7,
                padding: "5px 7px",
              }}
            >
              {projects.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label
            style={{ fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}
          >
            模型　
            <select
              value={model}
              onChange={(event) => {
                setModel(event.target.value);
                setSelected(null);
              }}
              style={{
                color: "inherit",
                background: "transparent",
                border: "1px solid var(--dsw-alias-border-l2)",
                borderRadius: 7,
                padding: "5px 7px",
              }}
            >
              {models.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
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

      <div
        style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 18 }}
      >
        <Metric
          icon={<IconDataOutline16 size={16} />}
          value={number(metrics.tokens)}
          label="累计词元数"
        />
        <Metric
          icon={<IconRightUpOutline16 size={16} />}
          value={number(metrics.peakDay)}
          label="单日峰值词元"
        />
        <Metric
          icon={<IconListPenOutline16 size={16} />}
          value={money(metrics.cost)}
          label="累计费用"
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
                    const tokens = day.tokens;
                    const level = levelOf(tokens, dayMaximum);
                    // 过去日期都可点（空块点开显示「该时段暂无用量记录」），仅未来不可点。
                    const interactive = !day.future;
                    return (
                      <button
                        key={day.at}
                        type="button"
                        disabled={!interactive}
                        title={`${fullLabel(day.at, "day")}：${number(tokens)} 词元，${money(day.cost)}`}
                        onClick={() =>
                          setSelected({ start: day.at, records: day.records })
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
                      const tokens = tokensOf(bucket.records);
                      const level = levelOf(tokens, weekMaximum);
                      return (
                        <button
                          key={bucket.start}
                          type="button"
                          title={`${fullLabel(bucket.start, "week")}：${number(tokens)} 词元，${money(total(bucket.records).cost)}`}
                          onClick={() =>
                            setSelected({
                              start: bucket.start,
                              records: bucket.records,
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
              const tokens = tokensOf(bucket.records);
              const level = levelOf(tokens, monthMaximum);
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
                    title={`${fullLabel(bucket.start, "month")}：${number(tokens)} 词元，${money(total(bucket.records).cost)}`}
                    onClick={() =>
                      setSelected({
                        start: bucket.start,
                        records: bucket.records,
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

        {selected === null ? (
          <p
            style={{
              margin: "14px 0 0",
              fontSize: 11,
              color: "var(--dsw-alias-label-tertiary)",
            }}
          >
            点击色块查看该
            {view === "day" ? "日" : view === "week" ? "周" : "月"}
            用量，下方汇总会同步切换。
          </p>
        ) : null}
      </div>

      {selected !== null && selectedTotals !== null ? (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginTop: 20,
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
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 12,
          marginTop: selected === null ? 20 : 12,
          padding: "13px 0",
          borderTop: "1px solid var(--dsw-alias-border-l2)",
          borderBottom: "1px solid var(--dsw-alias-border-l2)",
        }}
      >
        <Summary
          label="实际费用"
          value={money(shown.cost)}
          hint={`高峰 ${money(shown.peakCost)} · 闲时 ${money(shown.offCost)}`}
        />
        <Summary
          label="词元总数"
          value={number(
            shown.input + shown.cacheRead + shown.cacheWrite + shown.output,
          )}
          hint={`${number(shown.calls)} 次模型调用`}
        />
        <Summary
          label="输入 / 输出"
          value={`${number(shown.input + shown.cacheWrite)} / ${number(shown.output)}`}
          hint="未命中输入 / 输出"
        />
        <Summary
          label="缓存命中"
          value={number(shown.cacheRead)}
          hint={`缓存写入 ${number(shown.cacheWrite)}`}
        />
      </div>

      <p
        style={{
          margin: "12px 0 0",
          color: "var(--dsw-alias-label-tertiary)",
          fontSize: 11,
          lineHeight: 1.55,
        }}
      >
        {loading
          ? "正在读取用量…"
          : `费用按 DeepSeek 官方 V4-Flash / V4-Pro 峰谷单价估算：高峰（北京时间 9:00-12:00、14:00-18:00）按高峰价，其余时段半价；缓存写入按未命中输入计费。全部累计 ${money(allTime.cost)}。`}
      </p>
    </section>
  );
}
