import type { BurnRow } from "./burn-data";

export type WindowKey = "1" | "3" | "7" | "31" | "3m" | "6m" | "all";
export type DateRange = { start: string; end: string };
const DAY_MS = 86_400_000;

export function dayNumber(date: string) {
  return toUtcDate(date).getTime() / DAY_MS;
}

export function dayString(day: number) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Move by calendar days, preserving duration even when clamped at an edge. */
export function moveDateRange(range: DateRange, delta: number, bounds: DateRange): DateRange {
  const offset = Math.max(dayNumber(bounds.start) - dayNumber(range.start),
    Math.min(dayNumber(bounds.end) - dayNumber(range.end), Math.round(delta)));
  return { start: dayString(dayNumber(range.start) + offset), end: dayString(dayNumber(range.end) + offset) };
}

export function getWindowRange(rows: { date: string }[], windowKey: WindowKey): DateRange {
  const end = rows.at(-1)?.date || "1970-01-01";
  const start = rows[0]?.date || end;
  if (windowKey === "all" || !rows.length) return { start, end };
  const firstDate = toUtcDate(end);
  if (windowKey === "3m" || windowKey === "6m") {
    const day = firstDate.getUTCDate();
    firstDate.setUTCDate(1);
    firstDate.setUTCMonth(firstDate.getUTCMonth() - (windowKey === "3m" ? 3 : 6));
    const monthEnd = new Date(Date.UTC(firstDate.getUTCFullYear(), firstDate.getUTCMonth() + 1, 0)).getUTCDate();
    firstDate.setUTCDate(Math.min(day, monthEnd) + 1);
  } else {
    firstDate.setUTCDate(firstDate.getUTCDate() - Number(windowKey) + 1);
  }
  return { start: [start, firstDate.toISOString().slice(0, 10)].sort()[1], end };
}

export function getWindowRows(rows: BurnRow[], windowKey: WindowKey) {
  const range = getWindowRange(rows, windowKey);
  return rows.filter((row) => row.date >= range.start && row.date <= range.end);
}

export function toUtcDate(date: string) {
  return new Date(`${date}T00:00:00.000Z`);
}

export function lastCalendarDays(rows: BurnRow[], days: number) {
  if (!rows.length) return [];
  const cutoff = toUtcDate(rows[rows.length - 1].date);
  cutoff.setUTCDate(cutoff.getUTCDate() - days + 1);
  return rows.filter((row) => toUtcDate(row.date) >= cutoff);
}

export function freshness(refreshedAt: string, now: number) {
  const age = now - Date.parse(refreshedAt);
  if (!Number.isFinite(age) || age < -300_000) return "unknown";
  return age > 2 * 60 * 60_000 ? "stale" : "fresh";
}
