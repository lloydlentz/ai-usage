import type { BurnRow } from "./burn-data";

export function formatTokens(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return `${Math.round(value)}`;
}

// Formatted by hand rather than through Intl: this page is statically
// prerendered, and the CI runtime's ICU data does not have to match the
// viewer's. A hand-rolled formatter renders the same bytes in both passes.
export function formatUsd(value: number) {
  const negative = value < 0;
  const [whole, cents] = Math.abs(value).toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${cents}`;
}

export function formatPct(value: number) {
  if (value > 0 && value < 0.1) return "<0.1%";
  return `${value.toFixed(1)}%`;
}

export function sumTokens(rows: BurnRow[]) {
  return rows.reduce((sum, row) => sum + row.total, 0);
}

export function logHeatLevel(value: number, max: number) {
  if (value <= 0 || max <= 0) return 0;
  const level = Math.ceil((Math.log10(value + 1) / Math.log10(max + 1)) * 5);
  return Math.max(0, Math.min(5, level));
}

export function movingAverage7(rows: BurnRow[], index: number) {
  const start = Math.max(0, index - 6);
  const windowRows = rows.slice(start, index + 1);
  return sumTokens(windowRows) / windowRows.length;
}

/**
 * Human-scale comparisons for the tokens that were actually *written*.
 *
 * This used to run on the grand total, which is 96% cache reads — the same
 * context handed back to the model over and over. Counting a re-read as a
 * written word turned one long session into "20,428 novels", which measured
 * nothing. Output tokens are the only ones that correspond to text that came
 * into existence, so they are the only defensible input here. Input tokens are
 * shown alongside as the read side of the ledger: prose a person actually put
 * in, counted once.
 */
export function fermiScale(outputTokens: number, inputTokens: number) {
  const words = outputTokens * 0.75;
  const readingHours = words / 250 / 60;
  const novels = words / 90_000;

  return [
    {
      label: "Words written",
      value: formatTokens(words),
      note: "output tokens x 0.75",
    },
    {
      label: "Reading time",
      value: readingHours >= 1 ? `${Math.round(readingHours)}h` : "<1h",
      note: "250 words per minute",
    },
    {
      label: "Novel equivalents",
      value: novels.toFixed(1),
      note: "90k words per novel",
    },
    {
      label: "Words read in",
      value: formatTokens(inputTokens * 0.75),
      note: "uncached input, counted once",
    },
  ];
}
