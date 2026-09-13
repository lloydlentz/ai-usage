import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeRows, sumCost, sumToolCost, subtotalCost, sumByModel } from "../lib/burn-data";
import { movingAverage7 } from "../lib/token-math";
import { lastCalendarDays, freshness, getWindowRows, getWindowRange, moveDateRange, dayNumber } from "../lib/date-windows";
import { modelTokenShares, UNATTRIBUTED_MODEL } from "../lib/model-share";
import { parseDriverLabels } from "../lib/driver-labels";
import { normalizeThreads, summarizeThreads } from "../lib/threads";
import { CellCost, BasisPill } from "../app/components/cost";

const rows = normalizeRows([
  { date: "2026-03-01", codex_tokens: 700, driver: "research" },
  { date: "2026-03-08", codex_tokens: 140, driver: "research" },
  { date: "2026-03-10", codex_tokens: 70, driver: "research" },
]);
test("calendar average includes gaps and excludes older records, including DST", () => {
  assert.equal(movingAverage7(rows, 2), 30);
  assert.equal(movingAverage7([], 0), 0);
});
test("last N days uses dates rather than a count of records", () => {
  assert.deepEqual(lastCalendarDays(rows, 3).map((r) => r.date), ["2026-03-08", "2026-03-10"]);
});
test("freshness distinguishes delay and invalid clocks", () => {
  const stamp = "2026-09-10T17:00:00-05:00", time = Date.parse(stamp);
  assert.equal(freshness(stamp, time + 3_600_000), "fresh");
  assert.equal(freshness(stamp, time + 7_200_001), "stale");
  assert.equal(freshness("bad", time), "unknown");
  assert.equal(freshness(stamp, time - 1_000_000), "unknown");
});
test("all four cost states render without turning unknown into free", () => {
  const html = (cost: Parameters<typeof CellCost>[0]["cost"]) => renderToStaticMarkup(<><CellCost cost={cost}/><BasisPill/></>);
  assert.match(html({ kind: "not-measured" }), /—/);
  assert.match(html(subtotalCost(null, 100)), /not priced/);
  assert.doesNotMatch(html(subtotalCost(null, 100)), /\$0/);
  assert.match(html(subtotalCost(2, 100)), /≥.*\$2\.00/);
  assert.match(html(subtotalCost(0, 0)), /\$0\.00/);
  assert.match(html(subtotalCost(2, 0)), /at API list/);
});
test("tool and model subtotals preserve partial pricing", () => {
  const mixed = normalizeRows([{ date: "2026-09-10", codex_tokens: 1000, driver: "research", breakdown: { codex: { models: { partial: { tokens: 800, input: 700, output: 100, cost_usd: 2, unpriced_tokens: 100 } }, unattributed: 200 } }, cost_usd: { total: 2, unpriced_tokens: 300, by_tool: { codex: 2 } } }]);
  assert.equal(sumCost(mixed).kind, "lower-bound");
  assert.deepEqual(sumToolCost(mixed, "codex"), subtotalCost(2, 300));
  assert.equal(sumToolCost(mixed, "claude_code").kind, "not-measured");
  assert.equal(sumByModel(mixed)[0].unpricedTokens, 100);
  assert.equal(sumToolCost(rows, "codex").kind, "unknown");
});
test("label exports allow only dates and sanitized preset categories", () => {
  assert.deepEqual(parseDriverLabels({ "2026-09-10": "shipping", "2026-09-09": "/private/client", "bad": "admin" }), { "2026-09-10": "shipping" });
});


test("short periods use inclusive calendar days and month windows clamp month ends", () => {
  const history = normalizeRows(["2025-09-30", "2025-10-01", "2025-12-31", "2026-01-01", "2026-03-01", "2026-03-30", "2026-03-31"].map((date) => ({ date, driver: "research" })));
  assert.deepEqual(getWindowRows(history, "1").map((r) => r.date), ["2026-03-31"]);
  assert.deepEqual(getWindowRows(history, "3").map((r) => r.date), ["2026-03-30", "2026-03-31"]);
  assert.equal(getWindowRows(history, "31")[0].date, "2026-03-01");
  assert.equal(getWindowRows(history, "3m")[0].date, "2026-01-01");
  assert.equal(getWindowRows(history, "6m")[0].date, "2025-10-01");
  assert.equal(getWindowRows(history, "all").length, history.length);
});

test("model share combines tools, preserves unattributed volume and excludes estimates", () => {
  const history = normalizeRows([
    { date: "2026-09-08", driver: "research", codex_tokens: 300, claude_code_tokens: 200, breakdown: {
      codex: { models: { shared: { tokens: 250 } }, unattributed: 50 },
      claude_code: { models: { shared: { tokens: 200 } } },
    } },
    { date: "2026-09-09", driver: "research", codex_tokens: 100 },
    { date: "2026-09-10", driver: "research", chatgpt_est: 10000 },
  ]);
  assert.deepEqual(modelTokenShares(history), { total: 600, segments: [
    { model: "shared", tokens: 450, percent: 75 },
    { model: UNATTRIBUTED_MODEL, tokens: 150, percent: 25 },
  ] });
  assert.deepEqual(modelTokenShares(history.slice(-1)), { total: 0, segments: [] });
});


test("range presets retain missing calendar days and clamp to available history", () => {
  const dates = [{ date: "2026-02-10" }, { date: "2026-03-31" }];
  assert.deepEqual(getWindowRange(dates, "7"), { start: "2026-03-25", end: "2026-03-31" });
  assert.deepEqual(getWindowRange(dates, "3m"), { start: "2026-02-10", end: "2026-03-31" });
  assert.deepEqual(getWindowRange(dates, "1"), { start: "2026-03-31", end: "2026-03-31" });
});

test("sliding preserves inclusive duration across DST, gaps, and both history boundaries", () => {
  const bounds = { start: "2026-03-01", end: "2026-03-31" };
  const range = { start: "2026-03-07", end: "2026-03-09" };
  assert.deepEqual(moveDateRange(range, 1, bounds), { start: "2026-03-08", end: "2026-03-10" });
  assert.deepEqual(moveDateRange(range, -100, bounds), { start: "2026-03-01", end: "2026-03-03" });
  assert.deepEqual(moveDateRange(range, 100, bounds), { start: "2026-03-29", end: "2026-03-31" });
  assert.deepEqual(moveDateRange(bounds, 100, bounds), bounds);
  assert.equal(dayNumber("2026-03-09") - dayNumber("2026-03-07"), 2);
});

test("thread summaries count only days inside the range and keep partial pricing", () => {
  const threads = normalizeThreads([
    { key: "cx-a", tool: "codex", title: "Long thread", days: {
      "2026-09-01": { tokens: 100, cost_usd: 1, unpriced_tokens: 0, models: { "gpt-5.6-sol": { tokens: 100 } } },
      "2026-09-05": { tokens: 900, cost_usd: 2, unpriced_tokens: 0, models: { "gpt-6-astra": { tokens: 900 } } },
    } },
    { key: "cc-b", tool: "claude_code", title: "  ", days: {
      "2026-09-04": { tokens: 500, cost_usd: 3, unpriced_tokens: 50, models: { "claude-opus-5": { tokens: 450 }, "<synthetic>": { tokens: 0 } } },
    } },
    { key: "cc-empty", tool: "claude_code", title: "no tokens", days: { "2026-09-04": { tokens: 0 } } },
    { key: "xx-other", tool: "chatgpt", title: "unknown tool", days: { "2026-09-04": { tokens: 5 } } },
  ]);
  assert.deepEqual(threads.map((thread) => [thread.key, thread.title]), [["cx-a", "Long thread"], ["cc-b", null]]);
  const early = { start: "2026-09-01", end: "2026-09-04" };
  const month = { start: "2026-09-01", end: "2026-09-30" };
  assert.deepEqual(summarizeThreads(threads, early).map((t) => [t.key, t.tokens, t.model]),
    [["cc-b", 500, "claude-opus-5"], ["cx-a", 100, "gpt-5.6-sol"]]);
  assert.equal(summarizeThreads(threads, early)[0].cost.kind, "lower-bound");
  assert.deepEqual(summarizeThreads(threads, month).map((t) => [t.key, t.tokens, t.activeDays, t.firstDay, t.lastDay, t.model]),
    [["cx-a", 1000, 2, "2026-09-01", "2026-09-05", "gpt-6-astra"], ["cc-b", 500, 1, "2026-09-04", "2026-09-04", "claude-opus-5"]]);
  assert.deepEqual(summarizeThreads(threads, early, { sort: "recent" }).map((t) => t.key), ["cc-b", "cx-a"]);
  assert.deepEqual(summarizeThreads(threads, month, { tool: "claude_code" }).map((t) => t.key), ["cc-b"]);
  assert.deepEqual(summarizeThreads(threads, { start: "2026-09-10", end: "2026-09-30" }), []);
});

test("a thread whose tokens are all unpriced is not priced, never $0", () => {
  const [thread] = summarizeThreads(normalizeThreads([
    { key: "cx-i", tool: "codex", title: "Import", days: { "2026-06-08": { tokens: 9000, cost_usd: 0, unpriced_tokens: 9000, models: {} } } },
  ]), { start: "2026-06-01", end: "2026-06-30" });
  assert.equal(thread.cost.kind, "unknown");
  assert.equal(thread.model, null);
  assert.doesNotMatch(renderToStaticMarkup(<CellCost cost={thread.cost} />), /\$0/);
});
