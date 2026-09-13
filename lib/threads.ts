import { subtotalCost, toolKeys, type CostKnowledge, type ToolKey } from "./burn-data";
import type { DateRange } from "./date-windows";

// data/threads.json, as written by scripts/build_daily_burn.py. Optional
// everywhere for the same reason as RawBurnRow: absence is not zero.
type RawThreadDay = {
  tokens?: number;
  cost_usd?: number | null;
  unpriced_tokens?: number;
  models?: Record<string, { tokens?: number } | undefined>;
};

export type RawThread = {
  key: string;
  tool: string;
  title?: string | null;
  days?: Record<string, RawThreadDay | undefined>;
};

export type ThreadDay = {
  date: string;
  tokens: number;
  /** null means the day carried no cost block. Never coerce this to 0. */
  costUsd: number | null;
  unpricedTokens: number;
  models: Record<string, number>;
};

export type Thread = { key: string; tool: ToolKey; title: string | null; days: ThreadDay[] };

export function normalizeThreads(raw: RawThread[]): Thread[] {
  return raw.flatMap((thread) => {
    const tool = toolKeys.find((key) => key === thread.tool);
    if (!tool) return [];
    const days = Object.entries(thread.days || {})
      .filter((pair): pair is [string, RawThreadDay] => Boolean(pair[1]))
      .map(([date, day]) => ({
        date,
        tokens: finite(day.tokens),
        costUsd: typeof day.cost_usd === "number" && Number.isFinite(day.cost_usd) ? day.cost_usd : null,
        unpricedTokens: finite(day.unpriced_tokens),
        models: Object.fromEntries(Object.entries(day.models || {}).map(([model, usage]) => [model, finite(usage?.tokens)])),
      }))
      .filter((day) => day.tokens > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    return days.length ? [{ key: thread.key, tool, title: thread.title?.trim() || null, days }] : [];
  });
}

export type ThreadSort = "tokens" | "recent";

export type ThreadSummary = {
  key: string;
  tool: ToolKey;
  title: string | null;
  tokens: number;
  cost: CostKnowledge;
  firstDay: string;
  lastDay: string;
  activeDays: number;
  /** The model with the most tokens in the range; null when none is named. */
  model: string | null;
};

/**
 * Each thread's part of a date range. Only a thread's days inside the range
 * count, so a thread that ran for weeks ranks by what it spent in the period,
 * not by its lifetime. Cost keeps its uncertainty through subtotalCost.
 */
export function summarizeThreads(
  threads: Thread[],
  range: DateRange,
  { tool = "all", sort = "tokens" }: { tool?: ToolKey | "all"; sort?: ThreadSort } = {},
): ThreadSummary[] {
  const summaries: ThreadSummary[] = [];
  for (const thread of threads) {
    if (tool !== "all" && thread.tool !== tool) continue;
    const days = thread.days.filter((day) => day.date >= range.start && day.date <= range.end);
    if (!days.length) continue;
    let tokens = 0;
    let usd: number | null = null;
    let unpriced = 0;
    const models = new Map<string, number>();
    for (const day of days) {
      tokens += day.tokens;
      unpriced += day.unpricedTokens;
      if (day.costUsd !== null) usd = (usd ?? 0) + day.costUsd;
      for (const [model, count] of Object.entries(day.models)) models.set(model, (models.get(model) || 0) + count);
    }
    const [model] = [...models]
      .filter(([name, count]) => count > 0 && !name.startsWith("<"))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [null];
    summaries.push({
      key: thread.key,
      tool: thread.tool,
      title: thread.title,
      tokens,
      cost: subtotalCost(usd, unpriced),
      firstDay: days[0].date,
      lastDay: days[days.length - 1].date,
      activeDays: days.length,
      model,
    });
  }
  const byTokens = (a: ThreadSummary, b: ThreadSummary) => b.tokens - a.tokens;
  const byRecent = (a: ThreadSummary, b: ThreadSummary) => b.lastDay.localeCompare(a.lastDay);
  return summaries.sort((a, b) =>
    (sort === "recent" ? byRecent(a, b) || byTokens(a, b) : byTokens(a, b) || byRecent(a, b)) || a.key.localeCompare(b.key));
}

function finite(value: number | undefined) {
  return Number.isFinite(value) ? Number(value) : 0;
}
