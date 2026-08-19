import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  IconDataOutline16,
  IconGoalOutline16,
  IconListPenOutline16,
  IconRightUpOutline16,
  IconSparkle16,
} from "./icons.tsx";

type View = "day" | "week" | "month";

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
    summary.input +
    summary.output +
    summary.cacheRead +
    summary.cacheWrite
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

/** 某天在项目/模型筛选下应使用的聚合桶。 */
function summaryFor(
  day: DaySummary | undefined,
  project: string,
  model: string,
): CellSummary {
  if (day === undefined) return emptySummary();
  if (project === "全部项目" && model === "全部模型") return day.total;
  if (project !== "全部项目" && model !== "全部模型")
    return day.cells[`${project}\u0000${model}`] ?? emptySummary();
  if (project !== "全部项目") return day.byProject[project] ?? emptySummary();
  return day.byModel[model] ?? emptySummary();
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

function dayKeyOf(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isNextDay(a: string, b: string): boolean {
  return (
    dayKeyToStart(b) - dayKeyToStart(a) === DAY
  );
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
  return firstOfMonth >= weekStart && firstOfMonth < weekStart + 7 * DAY
    ? `${monday.getMonth() + 1}月`
    : undefined;
}

function levelOf(value: number, maximum: number): number {
  if (value <= 0 || maximum <= 0) return 0;
  const ratio = value / maximum;
  return Math.min(4, Math.max(1, Math.ceil(ratio * 4)));
}

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
  summary: CellSummary;
  future: boolean;
}

interface Bucket {
  start: number;
  summary: CellSummary;
}

export function UsageSection() {
  const [days, setDays] = useState<Record<string, DaySummary>>({});
  const [today, setToday] = useState<RecordItem[]>([]);
  const [view, setView] = useState<View>("day");
  const [project, setProject] = useState("全部项目");
  const [model, setModel] = useState("全部模型");
  const [selected, setSelected] = useState<{ start: number; summary: CellSummary } | null>(
    null,
  );
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
  const models = useMemo(() => {
    const set = new Set(today.map((record) => record.model));
    for (const day of Object.values(days)) {
      for (const name of Object.keys(day.byModel)) set.add(name);
    }
    return ["全部模型", ...Array.from(set).sort()];
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
      const start = thisMonday - week * 7 * DAY;
      const days: DayCell[] = [];
      for (let offset = 0; offset < 7; offset += 1) {
        const at = start + offset * DAY;
        days.push(
          dayCells.get(at) ?? { at, summary: emptySummary(), future: at > todayStart },
        );
      }
      weeks.push({ start, days });
    }
    return weeks;
  }, [dayCells, thisMonday, todayStart]);

  const weekBuckets = useMemo(() => {
    const buckets: Bucket[] = [];
    for (let week = 15; week >= 0; week -= 1) {
      const start = thisMonday - week * 7 * DAY;
      const cells: CellSummary[] = [];
      for (const [key, summary] of filteredDays) {
        const at = dayKeyToStart(key);
        if (at >= start && at < start + 7 * DAY) cells.push(summary);
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
  const totals = useMemo(() => {
    const shown =
      view === "day"
        ? dayWeeks.flatMap((week) => week.days).map((day) => day.summary)
        : view === "week"
          ? weekBuckets.map((bucket) => bucket.summary)
          : monthBuckets.map((bucket) => bucket.summary);
    return totalsOf(sumCells(shown));
  }, [view, dayWeeks, weekBuckets, monthBuckets]);
  const allTime = useMemo(
    () => totalsOf(sumCells(Array.from(filteredDays.values()))),
    [filteredDays],
  );

  const metrics = useMemo(() => {
    const all = sumCells(Array.from(filteredDays.values()));
    const { current, longest } = streaks(Array.from(filteredDays.keys()));
    let peakDay = 0;
    for (const summary of filteredDays.values()) peakDay = Math.max(peakDay, tokensOf(summary));
    return {
      tokens: tokensOf(all),
      peakDay,
      cost: all.cost,
      current,
      longest,
    };
  }, [filteredDays]);

  const dayMaximum = useMemo(
    () =>
      Math.max(
        ...dayWeeks.flatMap((week) => week.days).map((day) => tokensOf(day.summary)),
        0,
      ),
    [dayWeeks],
  );
  const weekMaximum = useMemo(
    () => Math.max(...weekBuckets.map((bucket) => tokensOf(bucket.summary)), 0),
    [weekBuckets],
  );
  const monthMaximum = useMemo(
    () => Math.max(...monthBuckets.map((bucket) => tokensOf(bucket.summary)), 0),
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
            DeepSeek 官方 + OpenCode Free + Codex 订阅 · 历史按天聚合缓存 · 自动保存
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
                    const tokens = tokensOf(day.summary);
                    const level = levelOf(tokens, dayMaximum);
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
                      const level = levelOf(tokens, weekMaximum);
                      return (
                        <button
                          key={bucket.start}
                          type="button"
                          title={`${fullLabel(bucket.start, "week")}：${number(tokens)} 词元，${money(bucket.summary.cost)}`}
                          onClick={() =>
                            setSelected({ start: bucket.start, summary: bucket.summary })
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
                    title={`${fullLabel(bucket.start, "month")}：${number(tokens)} 词元，${money(bucket.summary.cost)}`}
                    onClick={() =>
                      setSelected({ start: bucket.start, summary: bucket.summary })
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

      {selected !== null ? (
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
          value={number(shown.tokens)}
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
          : `费用按 DeepSeek 官方 V4-Flash / V4-Pro 峰谷单价估算：高峰（北京时间 9:00-12:00、14:00-18:00）按高峰价，其余时段半价；缓存写入按未命中输入计费。OpenCode Free 与 Codex 订阅仅统计词元、不计费。历史数据按天聚合缓存（仅今天保留逐条明细）。全部累计 ${money(allTime.cost)}。`}
      </p>
    </section>
  );
}
