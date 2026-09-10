import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeRows, sumCost, sumToolCost, subtotalCost, sumByModel } from "../lib/burn-data";
import { movingAverage7 } from "../lib/token-math";
import { lastCalendarDays, freshness, getWindowRows } from "../lib/date-windows";
import { modelTokenShares, UNATTRIBUTED_MODEL } from "../lib/model-share";
import { parseDriverLabels } from "../lib/driver-labels";
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
