import type { BurnRow } from "./burn-data";

export type WindowKey = "1" | "3" | "7" | "31" | "3m" | "6m" | "all";

export function getWindowRows(rows: BurnRow[], windowKey: WindowKey) {
  if (windowKey === "all" || rows.length === 0) return rows;

  const lastDate = toUtcDate(rows[rows.length - 1].date);
  const firstDate = new Date(lastDate);
  if (windowKey === "3m" || windowKey === "6m") {
    // Rolling calendar months, clamped at short month ends before making
    // the lower boundary inclusive (e.g. May 31 minus 3 months -> March 1).
    const day = firstDate.getUTCDate();
    firstDate.setUTCDate(1);
    firstDate.setUTCMonth(firstDate.getUTCMonth() - (windowKey === "3m" ? 3 : 6));
    const monthEnd = new Date(Date.UTC(firstDate.getUTCFullYear(), firstDate.getUTCMonth() + 1, 0)).getUTCDate();
    firstDate.setUTCDate(Math.min(day, monthEnd) + 1);
  } else {
    firstDate.setUTCDate(firstDate.getUTCDate() - Number(windowKey) + 1);
  }

  return rows.filter((row) => toUtcDate(row.date) >= firstDate);
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
