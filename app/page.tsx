"use client";

import { useEffect, useMemo, useState } from "react";

import { BasisPill, CostAmount, CellCost, UnpricedNote } from "./components/cost";
import { ModelShare } from "./components/model-share";
import { UsageTimeline } from "./components/usage-timeline";
import rawRows from "../data/daily-burn.json";
import pricing from "../data/pricing.json";
import { UsageExplorer } from "./components/usage-explorer";
import meta from "../data/meta.json";
import {
  emptyByType,
  normalizeRows,
  sourceColumns,
  sumByModel,
  subtotalCost,
  sumToolCost,
  sumCost,
  sumSource,
  sumTokensByType,
  tokenTypeLabels,
  tokenTypes,
  toolLabels,
  type CostKnowledge,
  type TokenType,
  type ToolKey,
} from "../lib/burn-data";
import { getWindowRange, lastCalendarDays, freshness, dayString, dayNumber, type DateRange, type WindowKey } from "../lib/date-windows";
import {
  fermiScale,
  formatPct,
  formatTokens,
  formatUsd,
  logHeatLevel,
  movingAverage7,
  sumTokens,
} from "../lib/token-math";

const rows = normalizeRows(rawRows);
const modelNames = [...new Set(rows.flatMap((row) => row.breakdown?.flatMap((tool) => tool.models.map((model) => model.model)) || []))].sort();

type Theme = "ticker" | "printrun";
const THEME_STORAGE_KEY = "dashboard-theme";

type ToolSource = {
  key: "claude" | "chatgpt";
  label: string;
  ticker: string;
  color: string;
  today: number;
  todayKnown: boolean;
  yesterdayKnown: boolean;
  yesterday: number;
  week: number;
  total: number;
  selected: number;
  history: (number | null)[];
};

function pctDelta(curr: number, prev: number) {
  if (prev === 0) return curr === 0 ? 0 : 100;
  return ((curr - prev) / prev) * 100;
}

// Every row in daily-burn.json is bucketed to an America/Chicago day by the
// Python pipeline, so the UI has to ask for dates in that same zone.
const DATA_TIME_ZONE = "America/Chicago";

// en-CA formats as YYYY-MM-DD, the shape the row dates already use. Reading the
// day with toISOString() instead would answer in UTC, which is already tomorrow
// from 7pm Chicago onward.
function chicagoDay(instant: Date) {
  return instant.toLocaleDateString("en-CA", { timeZone: DATA_TIME_ZONE });
}

// Step whole days off a YYYY-MM-DD string. The anchor is deliberately UTC: UTC
// days are always exactly 24h, so a DST transition cannot slide the result the
// way subtracting milliseconds from a local-midnight Date would.
function addDays(day: string, delta: number) {
  const anchor = new Date(`${day}T00:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() + delta);
  return anchor.toISOString().slice(0, 10);
}

function formatRefreshed(iso: string) {
  // Zone is pinned so the prerendered HTML (built in UTC CI) and the viewer's
  // browser produce the same string instead of mismatching on hydration.
  return new Date(iso).toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    timeZone: DATA_TIME_ZONE,
  });
}

export default function TokenBurnDashboard() {
  const [showDateFilters, setShowDateFilters] = useState(false);
  const [windowKey, setWindowKey] = useState<WindowKey | "custom">("all");
  const [range, setRange] = useState<DateRange>(() => getWindowRange(rows, "all"));
  const bounds = getWindowRange(rows, "all");
  const selectRange = (next: DateRange) => { setRange(next); setWindowKey(next.start === bounds.start && next.end === bounds.end ? "all" : "custom"); };
  const [now, setNow] = useState(() => Date.parse(meta.collected_at || meta.refreshed_at));
  const [theme, setTheme] = useState<Theme>("printrun");
  const [mounted, setMounted] = useState(false);

  // "Today" depends on when the page is viewed, but this page is statically
  // exported: computing it during render would bake the CI build machine's date
  // into the markup and disagree with the browser's first render. Seed from the
  // data's own refresh stamp — a static import, so both passes agree, and
  // normally the same Chicago day — then correct it to the viewer's real day
  // once mounted.
  const [today, setToday] = useState(() => chicagoDay(new Date(meta.refreshed_at)));

  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem(THEME_STORAGE_KEY); } catch { /* Storage is optional. */ }
    // SSR-safe hydration correction: this page is a static export, so the first
    // client render must be byte-identical to the prerendered HTML. The stored
    // theme and the viewer's real Chicago day are only knowable on the client,
    // so they can only be applied after mount. Restructuring this to avoid
    // setState-in-effect would reintroduce a hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved === "ticker" || saved === "printrun") setTheme(saved);
    setToday(chicagoDay(new Date()));
    setMounted(true);
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
      setToday(chicagoDay(new Date()));
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (mounted) {
      try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* Keep the in-memory preference. */ }
    }
  }, [theme, mounted]);

  // Mirror the theme onto <html> so body background (outside .page) matches too.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const selectedRows = useMemo(() => rows.filter((row) => row.date >= range.start && row.date <= range.end), [range]);
  const overdueRates = Object.entries(pricing.models).filter(([, entry]) => "review_after" in entry && String(entry.review_after) < today).map(([name]) => name);
  const refreshState = mounted ? freshness(meta.collected_at || "", now) : "unknown";
  const refreshLabel = refreshState === "fresh" ? "Recently refreshed" : refreshState === "stale" ? "Refresh overdue" : (mounted ? "Collection time unavailable" : "Checking refresh");
  const total = sumTokens(selectedRows);
  const maxDay = Math.max(...selectedRows.map((row) => row.total), 0);

  // Calculate dominant tool per day for Total calendar coloring
  const dominantToolMap = useMemo(() => {
    const map = new Map<string, "claude" | "chatgpt">();
    selectedRows.forEach((row) => {
      if (row.claude_code_tokens > row.codex_tokens) {
        map.set(row.date, "claude");
      } else if (row.codex_tokens > row.claude_code_tokens) {
        map.set(row.date, "chatgpt");
      }
    });
    return map;
  }, [selectedRows]);

  const peakDay = selectedRows.reduce(
    (peak, row) => (row.total > peak.total ? row : peak),
    selectedRows[0],
  );
  const lastAverage =
    selectedRows.length > 0 ? movingAverage7(rows, rows.findIndex((row) => row.date === selectedRows[selectedRows.length - 1].date)) : 0;
  const drivers = buildDriverRows(selectedRows, total);
  const sourceTotal = sourceColumns.reduce((sum, source) => sum + sumSource(selectedRows, source.key), 0);
  const tableRows = lastCalendarDays(selectedRows, 30).reverse();

  const yesterday = addDays(today, -1);

  const todayRows = rows.filter((r) => r.date === today);
  const yesterdayRows = rows.filter((r) => r.date === yesterday);
  const weekRows = lastCalendarDays(rows, 7);
  const historyDates = Array.from({ length: 14 }, (_, i) => dayString(dayNumber(bounds.end) - 13 + i));
  const toolHistory = (key: "claude_code_tokens" | "codex_tokens") => historyDates.map((date) => rows.find((row) => row.date === date)?.[key] ?? null);

  const todayKnown = todayRows.length > 0;
  const yesterdayKnown = yesterdayRows.length > 0;

  const claudeToday = sumSource(todayRows, "claude_code_tokens");
  const codexToday = sumSource(todayRows, "codex_tokens");
  const claudeYesterday = sumSource(yesterdayRows, "claude_code_tokens");
  const codexYesterday = sumSource(yesterdayRows, "codex_tokens");
  const claudeWeek = sumSource(weekRows, "claude_code_tokens");
  const codexWeek = sumSource(weekRows, "codex_tokens");
  const claudeTotal = sumSource(rows, "claude_code_tokens");
  const codexTotal = sumSource(rows, "codex_tokens");

  const totalToday = todayRows.reduce((sum, r) => sum + r.total, 0);
  const totalYesterday = yesterdayRows.reduce((sum, r) => sum + r.total, 0);

  // The cost side of the ledger. Only measured tokens are ever priced, so the
  // token figure shown beside the dollars counts the same universe — pairing
  // dollars with the all-sources total (which folds in unpriced chat estimates)
  // would make the two numbers describe different things.
  const measured = useMemo(() => sumTokensByType(selectedRows), [selectedRows]);
  const cost = useMemo(() => sumCost(selectedRows), [selectedRows]);
  const modelTotals = useMemo(() => sumByModel(selectedRows), [selectedRows]);
  const costByType = cost.kind === "priced" || cost.kind === "lower-bound" ? cost.byType : emptyByType();
  const costTotal = cost.kind === "priced" || cost.kind === "lower-bound" ? cost.usd : 0;

  const shiftSegments: ShiftSegment[] = tokenTypes.map((type) => ({
    type,
    label: tokenTypeLabels[type],
    tokens: measured.byType[type],
    tokenPct: measured.typed ? (measured.byType[type] / measured.typed) * 100 : 0,
    cost: costByType[type],
    costPct: costTotal ? (costByType[type] / costTotal) * 100 : 0,
  }));

  const cacheReadSeg = shiftSegments.find((s) => s.type === "cache_read");
  // The headline divergence is whichever type gains the most share moving from
  // the volume bar to the cost bar. Read from the data so the sentence stays
  // true if the mix shifts.
  const widestGap = shiftSegments.reduce(
    (best, seg) => (seg.costPct - seg.tokenPct > best.costPct - best.tokenPct ? seg : best),
    shiftSegments[0],
  );

  const toolSources: ToolSource[] = [
    {
      key: "claude", label: "Claude Code", ticker: "CLDE", color: "var(--accent)",
      todayKnown, yesterdayKnown,
      today: claudeToday, yesterday: claudeYesterday, week: claudeWeek, total: claudeTotal,
      selected: sumSource(selectedRows, "claude_code_tokens"), history: toolHistory("claude_code_tokens"),
    },
    {
      // Exact Codex CLI tokens. Labelled "Codex", not "ChatGPT": the ChatGPT app
      // is a separate, estimated column and conflating the two made the exact
      // number look like it counted chat usage.
      key: "chatgpt", label: "Codex", ticker: "CDX", color: "var(--good)",
      todayKnown, yesterdayKnown,
      today: codexToday, yesterday: codexYesterday, week: codexWeek, total: codexTotal,
      selected: sumSource(selectedRows, "codex_tokens"), history: toolHistory("codex_tokens"),
    },
  ];

  const refreshToggle = (
    <button
      type="button"
      className="refreshToggle"
      aria-expanded={showDateFilters}
      aria-controls="date-filters"
      onClick={() => setShowDateFilters((visible) => !visible)}
    >
      {refreshLabel}
    </button>
  );

  return (
    <main className="page" data-theme={theme}>
      <ThemeToggle theme={theme} onChange={setTheme} />
      {mounted && Object.values(meta.sources_available).some((available) => !available) && <p className="ledgerWarn">A usage source was unavailable during collection. Missing readings are unknown.</p>}
      {refreshState === "stale" && <p className="ledgerWarn">No successful refresh in over two hours. Collection or publication may be delayed. Today’s missing readings are unknown, not zero usage.</p>}
      {!selectedRows.length && <p role="status">No recorded days in this date range.</p>}

      {theme === "ticker" && (
        <TickerTape
          toolSources={toolSources}
          totalToday={totalToday}
          totalYesterday={totalYesterday}
          total={total}
          peakDay={peakDay}
          lastAverage={lastAverage}
        />
      )}

      <section className="heroRow">
        <div className="heroCol">
          {theme === "ticker" ? (
            <TickerHeroContent refreshedAt={meta.refreshed_at} refreshToggle={refreshToggle} />
          ) : (
            <PrintRunHero issueNo={rows.length} refreshedAt={meta.refreshed_at} refreshToggle={refreshToggle} />
          )}
        </div>
      </section>

      <section id="date-filters" className="dashboardControls" aria-label="Date filters" hidden={!showDateFilters}>
        <label>Period<select value={windowKey} onChange={(e) => { const key = e.target.value as WindowKey; setWindowKey(key); setRange(getWindowRange(rows, key)); }}>
          {windowKey === "custom" && <option value="custom">Custom range</option>}
          <option value="1">1 day</option><option value="3">3 days</option><option value="7">7 days</option><option value="31">31 days</option><option value="3m">3 months</option><option value="6m">6 months</option><option value="all">All time</option>
        </select></label>
        <label>From<input type="date" value={range.start} min={bounds.start} max={range.end} onChange={(e) => { if (e.target.value) selectRange({ ...range, start: [bounds.start, e.target.value, range.end].sort()[1] }); }} /></label>
        <label>Through<input type="date" value={range.end} min={range.start} max={bounds.end} onChange={(e) => { if (e.target.value) selectRange({ ...range, end: [range.start, e.target.value, bounds.end].sort()[1] }); }} /></label>
        <button type="button" onClick={() => { setWindowKey("all"); setRange(bounds); }}>Reset dates</button>
      </section>

      <section className="timelineRow">
        <article className="panel">
          <ToolSummary sources={toolSources} today={today} through={bounds.end} />
          <UsageTimeline rows={rows} range={range} onRangeChange={selectRange} />
          <ModelShare rows={selectedRows} modelNames={modelNames} />
        </article>
      </section>

      <section className="ledger" aria-label="Volume beside cost">
        {/* Neither figure gets a headline block of its own: the token count is
            anchored to the left end of the flow it measures, and the cost sits
            over the right end as a label on the flow's other side. Printed
            twice — once big, once as an axis label — they read as competing
            stats instead of one statement flowing end to end. */}
        <ShapeShift
          segments={shiftSegments}
          tokenTotal={measured.typed}
          costTotal={costTotal}
          costKind={cost.kind}
          volumeNote={
            <>
              <span className="pill exact">exact</span> tokens with a recorded type split;{" "}
              {cacheReadSeg ? formatPct(cacheReadSeg.tokenPct) : "—"} cache reads.
            </>
          }
          costNote="At current standard API rates for short context. Actual subscription spending is not measured here."
        />

        <p className="ledgerNote">
          <strong>Volume and cost are not the same shape.</strong> {widestGap.label} is{" "}
          {formatPct(widestGap.tokenPct)} of the volume and{" "}
          {formatPct(widestGap.costPct)} of the cost;{" "}
          {cacheReadSeg
            ? `cache read is ${formatPct(cacheReadSeg.tokenPct)} and ${formatPct(cacheReadSeg.costPct)}`
            : ""}
          . A cached token bills at a tenth of a fresh one, so a long session inflates the
          token count far faster than the bill.
        </p>
        <UnpricedNote cost={cost} unattributed={measured.unattributed} />
      </section>

      <section className="calendarRow">
        <Panel
          label="Daily burn"
          title={theme === "ticker" ? "Trading calendar" : "Activity calendar"}
          note={
            theme === "ticker"
              ? "Tile color marks the day's leading tool."
              : "Log color scale so quiet days and spikes can share one surface."
          }
        >
          <div className="heatmapTimeframe">
            {selectedRows.length > 0 && (
              <span>
                {selectedRows[0].date} – {selectedRows[selectedRows.length - 1].date}
              </span>
            )}
          </div>
          <div className="heatmapContainer">
            {["Total", "Claude Code", "Codex CLI"].map((label, idx) => (
              <GitHubHeatmap
                key={label}
                label={label}
                rows={selectedRows}
                valueKey={idx === 0 ? "total" : idx === 1 ? "claude_code_tokens" : "codex_tokens"}
                maxDay={maxDay}
                dominantToolMap={idx === 0 ? dominantToolMap : undefined}
                toolColor={idx === 1 ? "claude" : idx === 2 ? "chatgpt" : undefined}
              />
            ))}
            <div className="heatmapLegend">
              <span>less</span>
              {[0, 1, 2, 3, 4, 5].map((level) => (
                <i key={level} className={`heat${level}`} />
              ))}
              <span>more</span>
            </div>
          </div>
        </Panel>
      </section>

      <section className="stats" aria-label="Token burn summary">
        <Metric label="Total burn" value={formatTokens(total)} note="selected window" />
        <Metric label="Peak day" value={formatTokens(peakDay?.total || 0)} note={peakDay?.date || "n/a"} />
        <Metric label="7d average" value={formatTokens(lastAverage)} note="recorded tokens ÷ 7 calendar days" />
        <Metric label="Active days" value={`${selectedRows.filter((row) => row.codex_tokens + row.claude_code_tokens > 0).length}`} note="days with measured usage" />
      </section>

      <section className="grid gridCost">
        <Panel
          label="Cost by model"
          title="API equivalent by model"
          note="Ranked by cost at API list prices, not by token count."
        >
          <div className="modelList">
            {modelTotals.map((model) => {
              const share = costTotal && model.costUsd !== null ? (model.costUsd / costTotal) * 100 : 0;
              return (
                <div key={`${model.tool}-${model.model}`} className="modelRow">
                  <div className="modelName">
                    <strong>{model.model}</strong>
                    <span className="muted">{toolLabels[model.tool]}</span>
                  </div>
                  <span className="track">
                    <i style={{ width: `${share}%` }} />
                  </span>
                  <div className="modelFigures">
                    <strong>
                      <CellCost cost={subtotalCost(model.costUsd, model.unpricedTokens)} /> <BasisPill />
                    </strong>
                    <span className="muted">{formatTokens(model.tokens)} tokens</span>
                  </div>
                </div>
              );
            })}
            {modelTotals.length === 0 && (
              <p className="muted">No per-model split recorded in this window.</p>
            )}
          </div>
          <p className="panelFoot">
            <BasisPill /> Every figure in this panel is a counterfactual at API list prices.
          </p>
        </Panel>

        <Panel
          label="Cost by tool"
          title="API equivalent by tool"
          note="Chat estimates are never priced — only exact logs carry a cost."
        >
          <div className="driverGrid">
            {(["claude_code", "codex"] as ToolKey[]).map((tool) => {
              const toolCost = sumToolCost(selectedRows, tool);
              const value = toolCost.kind === "priced" || toolCost.kind === "lower-bound" ? toolCost.usd : undefined;
              const share = costTotal && value !== undefined ? (value / costTotal) * 100 : 0;
              return (
                <div key={tool} className="driver">
                  <strong>{toolLabels[tool]}</strong>
                  <span className="track">
                    <i style={{ width: `${share}%` }} />
                  </span>
                  <span><CellCost cost={toolCost} /> <BasisPill /></span>
                </div>
              );
            })}
            {/* Named rather than omitted: the estimated columns are a real part
                of the token total, and leaving them out of this panel would
                imply the priced tools are all there is. */}
            <div className="driver">
              <strong>Chat, estimated</strong>
              <span className="track" />
              <span className="muted">not priced</span>
            </div>
          </div>
          <p className="panelFoot">
            <BasisPill /> Counterfactual at API list prices.{" "}
            {measured.measuredDays} of {selectedRows.length} days in view carry a measured split;
            days without a split may be estimates only or older measurements with unknown composition.
          </p>
        </Panel>
      </section>

      <section className="grid">
        <Panel
          label="Source split"
          title="Exact beside estimated"
          note="The source labels are part of the dashboard, not a footnote."
        >
          <div className="sourceGrid">
            {sourceColumns.map((source) => {
              const value = sumSource(selectedRows, source.key);
              const share = sourceTotal ? Math.round((value / sourceTotal) * 100) : 0;
              return (
                <div key={source.key} className="source">
                  <span className={`pill ${source.fidelity}`}>{source.fidelity}</span>
                  <strong>{formatTokens(value)}</strong>
                  <span className="muted">
                    {source.label} / {share}%
                  </span>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel
          label="Drivers"
          title="What is burning tokens"
          note="Categories explain the work behind the volume. Label uncategorized days in the explorer below."
        >
          <div className="driverGrid">
            {drivers.map((driver) => (
              <div key={driver.label} className="driver">
                <strong>{driver.label}</strong>
                <span className="track">
                  <i style={{ width: `${driver.share}%` }} />
                </span>
                <span>{driver.share}%</span>
              </div>
            ))}
          </div>
        </Panel>
      </section>

      <section className="grid">
        <Panel
          label="Scale equivalents"
          title="How much of it was writing"
          note="Counted from output tokens — the only ones that became new text."
        >
          <div className="equivalents">
            {fermiScale(measured.byType.output, measured.byType.input).map((item) => (
              <div key={item.label} className="equivalent">
                <span className="muted">{item.label}</span>
                <strong>{item.value}</strong>
                <span>{item.note}</span>
              </div>
            ))}
          </div>
          <p className="panelFoot">
            The {formatTokens(measured.byType.cache_read)} of cache reads are deliberately left
            out: they are the same context handed back to the model again, not words that were
            written.
          </p>
        </Panel>

        <Panel
          label="Peak day"
          title={peakDay?.driver || "No data"}
          note={peakDay?.evidence || "Add evidence notes to explain why a day spiked."}
        >
          <div className="sourceGrid">
            <Metric label="Date" value={peakDay?.date || "n/a"} note="local bucket" />
            <Metric label="Burn" value={formatTokens(peakDay?.total || 0)} note="all sources" />
            <div className="stat">
              <span className="label">Cost</span>
              <CostAmount cost={peakDay?.cost || { kind: "not-measured" }} className="statAmount" />
              <span>
                <BasisPill />
              </span>
            </div>
          </div>
        </Panel>
      </section>

      <UsageExplorer rows={selectedRows} />

      <section className="panel">
        <div className="panelHeader">
          <div>
            <p className="label">Moving-average table</p>
            <h2>Last 30 days</h2>
          </div>
          <p>Exact and estimated columns stay separate.</p>
        </div>
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Total</th>
                <th>
                  Cost <span className="thBasis">at API list</span>
                </th>
                <th>7d avg</th>
                <th>Codex CLI</th>
                <th>Claude Code</th>
                <th>Calls</th>
                <th>Claude chat est.</th>
                <th>ChatGPT est.</th>
                <th>Gemini est.</th>
                <th>Driver</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row) => {
                const originalIndex = rows.findIndex((candidate) => candidate.date === row.date);
                return (
                  <tr key={row.date}>
                    <td>
                      <strong>{row.date}</strong>
                    </td>
                    <td>{formatTokens(row.total)}</td>
                    <td>
                      <CellCost cost={row.cost} />
                    </td>
                    <td>{formatTokens(movingAverage7(rows, originalIndex))}</td>
                    <td>{formatTokens(row.codex_tokens)}</td>
                    <td>{formatTokens(row.claude_code_tokens)}</td>
                    <td>{row.claude_code_calls}</td>
                    <td>{formatTokens(row.claude_chat_est)}</td>
                    <td>{formatTokens(row.chatgpt_est)}</td>
                    <td>{formatTokens(row.gemini_est)}</td>
                    <td>{row.driver}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <p className="footerNote">Last log collection: {meta.collected_at ? formatRefreshed(meta.collected_at) : "unknown"} (America/Chicago). Data build time is shown separately below.</p>
      <p className="footerNote">Pricing verified {pricing.verified_at}. {pricing.benchmark}</p>
      {overdueRates.length > 0 && <p className="ledgerWarn">Pricing review overdue for {overdueRates.join(", ")}. The stored rate may no longer apply.</p>}
      <p className="footerNote">
        {theme === "ticker"
          ? `${refreshLabel} · hourly collection · `
          : "Run on a laser printer that pretends to be a riso · "}
        Data built:{" "}
        {new Date(meta.refreshed_at).toLocaleString("en-US", {
          month: "short", day: "numeric", year: "numeric",
          hour: "numeric", minute: "2-digit", timeZoneName: "short",
          // Without an explicit zone this renders as UTC in the CI prerender and
          // in the viewer's own zone on hydration — two different strings.
          timeZone: DATA_TIME_ZONE,
        })}
      </p>
    </main>
  );
}

function ThemeToggle({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  return (
    <div className="themeToggle" role="group" aria-label="Dashboard style">
      <button type="button" aria-pressed={theme === "ticker"} onClick={() => onChange("ticker")}>
        Ticker
      </button>
      <button type="button" aria-pressed={theme === "printrun"} onClick={() => onChange("printrun")}>
        Print Run
      </button>
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <strong>{value}</strong>
      <span>{note}</span>
    </div>
  );
}

function Panel({
  label,
  title,
  note,
  children,
}: {
  label: string;
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <article className="panel">
      <div className="panelHeader">
        <div>
          <p className="label">{label}</p>
          <h2>{title}</h2>
        </div>
        <p>{note}</p>
      </div>
      {children}
    </article>
  );
}

// --- The shape shift: the same five token types, weighted two ways ----------

type ShiftSegment = {
  type: TokenType;
  label: string;
  tokens: number;
  tokenPct: number;
  cost: number;
  costPct: number;
};

const typeVar = (type: TokenType) => `var(--t-${type.replace(/_/g, "-")})`;

/* Sankey geometry, in viewBox units. Volume stacks on the left, cost on the
   right, and each type's flow connects its two sizes — so a type that costs
   more than its share of volume widens across the middle, and one that costs
   less pinches in. Only the cost side labels itself in-chart: the legend rail
   sits immediately left of the volume bar and already names every band, so a
   left-hand label would be the same text twice, and `lx` can sit near the edge
   instead of reserving a column for one. `labelMinH` is the height a node needs
   before it can carry its own name without colliding with its neighbours. */
const SANKEY = {
  w: 1000,
  h: 336,
  nodeW: 20,
  gap: 5,
  lx: 26,
  rx: 764,
  labelMinH: 15,
  /* Keeps the first and last node — and their labels, which centre on the node
     and so overhang it — off the edge of the viewBox. */
  padY: 12,
};

type SankeyNode = { top: number; h: number };

/** Stack percentage-sized nodes down a column, leaving a gap between each. */
function stackNodes(pcts: number[]): SankeyNode[] {
  const usable =
    SANKEY.h - SANKEY.padY * 2 - SANKEY.gap * Math.max(0, pcts.length - 1);
  let y = SANKEY.padY;
  return pcts.map((p) => {
    const h = (p / 100) * usable;
    const node = { top: y, h };
    y += h + SANKEY.gap;
    return node;
  });
}

/** A closed ribbon from a left node's span to a right node's span. */
function flowPath(l: SankeyNode, r: SankeyNode) {
  const x1 = SANKEY.lx + SANKEY.nodeW;
  const x2 = SANKEY.rx;
  const c = (x2 - x1) * 0.5;
  return (
    `M ${x1} ${l.top} C ${x1 + c} ${l.top}, ${x2 - c} ${r.top}, ${x2} ${r.top}` +
    ` L ${x2} ${r.top + r.h} C ${x2 - c} ${r.top + r.h}, ${x1 + c} ${l.top + l.h}, ${x1} ${l.top + l.h} Z`
  );
}

/**
 * Geometry-only percentages. A segment worth 0.17% of the volume would render
 * sub-pixel and read as absent, so anything non-zero is floored to a visible
 * sliver and the rest are scaled down to keep the row summing to 100. The
 * printed numbers stay exact — only the widths are nudged.
 */
function displayWidths(values: number[], floor = 0.45) {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (total <= 0) return values.map(() => 0);
  const pcts = values.map((v) => (v / total) * 100);
  const lifted = pcts.map((p) => (p > 0 && p < floor ? floor : p));
  const added = lifted.reduce((s, v) => s + v, 0) - 100;
  if (added <= 0) return lifted;
  const shrinkable = lifted.reduce((s, v) => s + (v > floor ? v : 0), 0);
  return lifted.map((v) => (v > floor ? v - (v / shrinkable) * added : v));
}

/* Hover targets for a column of nodes. A type that is 0.2% of the volume draws
   as a 2px bar, which is not something a mouse can be asked to find, so each
   node's target is grown to the midpoint of the gap on either side. The bands
   tile the column exactly — no overlap, so the type under the cursor is never
   ambiguous — and every type ends up with at least the gap's worth of height. */
function hitBands(nodes: SankeyNode[]) {
  return nodes.map((n, i) => {
    const prev = nodes[i - 1];
    const next = nodes[i + 1];
    const top = prev ? (prev.top + prev.h + n.top) / 2 : n.top;
    const bottom = next ? (n.top + n.h + next.top) / 2 : n.top + n.h;
    return { top, h: Math.max(0, bottom - top) };
  });
}

function ShapeShift({
  segments,
  tokenTotal,
  costTotal,
  costKind,
  volumeNote,
  costNote,
}: {
  segments: ShiftSegment[];
  tokenTotal: number;
  costTotal: number;
  costKind: CostKnowledge["kind"];
  volumeNote?: React.ReactNode;
  costNote?: React.ReactNode;
}) {
  const [active, setActive] = useState<TokenType | null>(null);

  const tokenW = displayWidths(segments.map((s) => s.tokens));
  const costW = displayWidths(segments.map((s) => s.cost));

  const dim = (type: TokenType) => (active && active !== type ? 0.14 : 1);

  /* The same isolate-this-type gesture the legend keys carry, so a band can be
     picked up anywhere it is drawn — its ribbon, either of its nodes, or its
     row in the rail. Hovering here sets the same `active` the keys set, so the
     matching key lights up and reveals its numbers at the same time. */
  const pickType = (type: TokenType) => ({
    onMouseEnter: () => setActive(type),
    onMouseLeave: () => setActive(null),
    onClick: () => setActive(active === type ? null : type),
  });

  const priced = costKind === "priced" || costKind === "lower-bound";

  const left = stackNodes(tokenW);
  const right = stackNodes(costW);
  const leftHits = hitBands(left);
  const rightHits = hitBands(right);

  return (
    <div className="shift">
      {/* The two figures read across one row. The keys are not up here with
          them: they belong beside the flow, in .shiftBody below, where a row
          sits at the same rank as the band it names. */}
      <div className="shiftHeads">
        <div className="shiftVolume">
          <span className="shiftRowName">By volume</span>
          <span className="shiftAmount">
            <span className="shiftAmountStack">
              <span className="ledgerGhost" aria-hidden="true">
                {formatTokens(tokenTotal)}
              </span>
              <span className="ledgerAmountInk">{formatTokens(tokenTotal)}</span>
            </span>
            <span className="shiftAmountUnit">tokens</span>
          </span>
          {volumeNote && <span className="shiftHeadNote">{volumeNote}</span>}
        </div>
        <div className="shiftHead shiftHeadRight">
          <span className="shiftRowName">By cost</span>
          <span className="shiftRowValue">
            {costKind === "lower-bound" && "at least "}
            {priced ? formatUsd(costTotal) : "not priced"} <BasisPill />
          </span>
          {costNote && <span className="shiftHeadNote">{costNote}</span>}
        </div>
      </div>

      <div className="shiftBody">
        <div className="shiftRail">
          <ul className="shiftLegend">
            <li className="shiftLegendHead" aria-hidden="true">
              share of volume → share of cost
            </li>
            {segments.map((seg) => (
              <li key={seg.type}>
                <button
                  type="button"
                  className="shiftKey"
                  aria-pressed={active === seg.type}
                  onMouseEnter={() => setActive(seg.type)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(seg.type)}
                  onBlur={() => setActive(null)}
                  onClick={() => setActive(active === seg.type ? null : seg.type)}
                >
                  <i style={{ background: typeVar(seg.type) }} />
                  <span className="shiftKeyLabel">{seg.label}</span>
                  <span className="shiftKeyFlow">
                    <span className="shiftKeyPct">{formatPct(seg.tokenPct)}</span>
                    <span className="shiftKeyArrow" aria-hidden="true">
                      →
                    </span>
                    <span className="shiftKeyPct shiftKeyCost">
                      {priced ? formatPct(seg.costPct) : "—"}
                    </span>
                  </span>
                  {/* Always in the layout, revealed on hover or focus: showing it
                      only when active would jump the whole rail on every pass of
                      the mouse. */}
                  <span className="shiftKeyDetail">
                    {formatTokens(seg.tokens)} tokens
                    {priced ? ` · ${costKind === "lower-bound" ? "≥ " : ""}${formatUsd(seg.cost)}` : " · not priced"} {priced && <BasisPill />}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* preserveAspectRatio="none" is inert at desktop, where the height is
            auto and so already the viewBox ratio. It matters below 700px, where
            the CSS gives the flow an explicit height so it cannot collapse to a
            sliver: the stack stays proportional, and the in-chart labels are
            hidden by then, so nothing legible stretches. */}
        <svg
          className="shiftFlow"
          viewBox={`0 0 ${SANKEY.w} ${SANKEY.h}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Each token type sized twice: by share of volume on the left, by share of cost on the right. ${segments
            .map(
              (s) =>
                `${s.label}, ${formatPct(s.tokenPct)} of volume and ${
                  priced ? formatPct(s.costPct) : "no recorded"
                } cost`,
            )
            .join(". ")}`}
        >
          {/* Flows first so the nodes and labels sit on top of them. */}
          {segments.map((seg, i) => {
            const l = left[i];
            const r = right[i];
            if (l.h <= 0 && r.h <= 0) return null;
            return (
              <path
                key={seg.type}
                d={flowPath(l, r)}
                fill={typeVar(seg.type)}
                className="shiftRibbon"
                style={{ opacity: active && active !== seg.type ? 0.05 : undefined }}
                {...pickType(seg.type)}
              >
                <title>{`${seg.label}: ${formatPct(seg.tokenPct)} of volume, ${
                  priced ? formatPct(seg.costPct) : "no recorded"
                } of cost`}</title>
              </path>
            );
          })}

          {segments.map((seg, i) => {
            const l = left[i];
            const r = right[i];
            return (
              <g key={seg.type} opacity={dim(seg.type)} {...pickType(seg.type)}>
                <rect x={SANKEY.lx} y={l.top} width={SANKEY.nodeW} height={l.h} fill={typeVar(seg.type)}>
                  <title>{`${seg.label}: ${formatTokens(seg.tokens)} tokens (${formatPct(seg.tokenPct)} of volume)`}</title>
                </rect>
                <rect x={SANKEY.rx} y={r.top} width={SANKEY.nodeW} height={r.h} fill={typeVar(seg.type)}>
                  <title>{`${seg.label}: ${priced ? `${costKind === "lower-bound" ? "≥ " : ""}${formatUsd(seg.cost)} at API list` : "not priced"} (${formatPct(seg.costPct)} of cost)`}</title>
                </rect>

                {/* Only the cost side. A node names itself when it is tall
                    enough to hold the text, which on this data is the four that
                    actually cost something — the point of the chart. The volume
                    side is named by the legend rail beside it. */}
                {r.h >= SANKEY.labelMinH && (
                  <text
                    className="shiftNodeLabel"
                    x={SANKEY.rx + SANKEY.nodeW + 14}
                    y={r.top + r.h / 2}
                    dominantBaseline="middle"
                  >
                    <tspan>{seg.label}</tspan>
                    <tspan className="shiftNodePct" dx="8">
                      {priced ? formatPct(seg.costPct) : "—"}
                    </tspan>
                  </text>
                )}
              </g>
            );
          })}

          {/* Last, so they sit over the nodes: the grown hover targets. They
              carry the node tooltips too, since a transparent rect on top would
              otherwise swallow them. */}
          {segments.map((seg, i) => (
            <g key={seg.type} className="shiftHit" {...pickType(seg.type)}>
              <rect
                x={SANKEY.lx - 8}
                y={leftHits[i].top}
                width={SANKEY.nodeW + 16}
                height={leftHits[i].h}
              >
                <title>{`${seg.label}: ${formatTokens(seg.tokens)} tokens (${formatPct(seg.tokenPct)} of volume)`}</title>
              </rect>
              <rect
                x={SANKEY.rx - 8}
                y={rightHits[i].top}
                width={SANKEY.nodeW + 16}
                height={rightHits[i].h}
              >
                <title>{`${seg.label}: ${priced ? `${costKind === "lower-bound" ? "≥ " : ""}${formatUsd(seg.cost)} at API list` : "not priced"} (${formatPct(seg.costPct)} of cost)`}</title>
              </rect>
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}

// --- Ticker theme: hero + tool-use quote board -----------------------------

function TickerTape({
  toolSources,
  totalToday,
  totalYesterday,
  total,
  peakDay,
  lastAverage,
}: {
  toolSources: ToolSource[];
  totalToday: number;
  totalYesterday: number;
  total: number;
  peakDay: (typeof rows)[number] | undefined;
  lastAverage: number;
}) {
  const totalDelta = pctDelta(totalToday, totalYesterday);
  const comparable = toolSources.every((source) => source.todayKnown && source.yesterdayKnown);

  const tapeItems = (
    <>
      {toolSources.map((s) => {
        const d = pctDelta(s.today, s.yesterday);
        return (
          <span className="tkTapeItem" key={s.ticker}>
            {s.ticker} <b>{s.todayKnown ? formatTokens(s.today) : "no reading"}</b>{" "}
            <span className={d >= 0 ? "tkUp" : "tkDown"}>
              {s.todayKnown && s.yesterdayKnown ? (s.yesterday === 0 && s.today > 0 ? "new usage" : `${d >= 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(1)}%`) : "comparison unavailable"}
            </span>
          </span>
        );
      })}
      <span className="tkTapeItem">
        TOTAL <b>{formatTokens(total)}</b>{" "}
        <span className={totalDelta >= 0 ? "tkUp" : "tkDown"}>
          {comparable ? (totalYesterday === 0 && totalToday > 0 ? "new usage today" : `${totalDelta >= 0 ? "▲" : "▼"} ${Math.abs(totalDelta).toFixed(1)}% today`) : "daily comparison unavailable"}
        </span>
      </span>
      <span className="tkTapeItem">
        PEAK <b>{formatTokens(peakDay?.total || 0)}</b> · {peakDay?.date}
      </span>
      <span className="tkTapeItem">
        7D AVG <b>{formatTokens(lastAverage)}</b>
      </span>
    </>
  );

  return (
    <div className="tkTape" aria-hidden="true">
      <div className="tkTapeTrack">
        <span className="tkTapeGroup">{tapeItems}</span>
        <span className="tkTapeGroup">{tapeItems}</span>
      </div>
    </div>
  );
}

function TickerHeroContent({ refreshedAt, refreshToggle }: { refreshedAt: string; refreshToggle: React.ReactNode }) {
  return (
    <section className="hero tkHero">
      <div className="tkHeroRow">
        <div>
          <p className="eyebrow">Token Burn — Daily Sheet</p>
          <h1>Lloyd&apos;s token usage.</h1>
        </div>
        <div className="tkAsOf">
          Updated {formatRefreshed(refreshedAt)} · {refreshToggle}
        </div>
      </div>
      <p className="lead">
        Data from Claude Code and Codex logs, quoted like a burn rate — because that&apos;s exactly what it is.
      </p>
    </section>
  );
}

function PrintRunHero({ issueNo, refreshedAt, refreshToggle }: { issueNo: number; refreshedAt: string; refreshToggle: React.ReactNode }) {
  return (
    <section className="hero prHero">
      <div className="prStampRow">
        <span className="prStamp">Issue {String(issueNo).padStart(3, "0")} · Personal Zine</span>
        <span className="prMeta">Updated {formatRefreshed(refreshedAt)} · {refreshToggle}</span>
      </div>
      <div className="prH1Wrap">
        <p className="prGhost" aria-hidden="true">
          Lloyd&apos;s token usage.
        </p>
        <h1 className="prH1">Lloyd&apos;s token usage.</h1>
      </div>
      <p className="lead">
        Data from Claude Code and Codex logs. Printed hourly, one run at a time — this is issue{" "}
        {String(issueNo).padStart(3, "0")} off the press.
      </p>
    </section>
  );
}

function ToolSummary({ sources, today, through }: { sources: ToolSource[]; today: string; through: string }) {
  return <div className="toolSummary" role="region" aria-label="Tool usage summary">
    <h2 className="label usageSectionLabel">Daily burn</h2>
    <div className="toolSummaryHeader"><span>Measured tokens</span><span>14-day trend</span><span>Today</span><span>Last 7 days</span><span>Selected</span><span>All time</span></div>
    {sources.map((source) => <div className="toolSummaryRow" key={source.key}>
      <strong className="toolSummaryName"><i style={{ background: source.color }} />{source.label}</strong>
      <Sparkline data={source.history} color={source.color} />
      {/* No row for today is unknown, not zero: collection may be overdue. */}
      <span className={source.todayKnown ? "toolToday" : "toolToday toolNoReading"} data-label="Today">{source.todayKnown ? formatTokens(source.today) : "no reading"}</span>
      <span className="toolWeek" data-label="Last 7 days">{formatTokens(source.week)}</span>
      <strong className="toolSelected" data-label="Selected">{formatTokens(source.selected)}</strong>
      <span className="toolTotal" data-label="All time">{formatTokens(source.total)}</span>
    </div>)}
    <p className="toolSummaryNote">Today is {today} (America/Chicago) as of the last log collection. Week and trends through {through}. All time stays fixed while you explore.</p>
  </div>;
}

function Sparkline({ data, color }: { data: (number | null)[]; color: string }) {
  const width = 120, height = 24, padding = 1;
  const max = Math.max(...data.map((v) => v ?? 0), 1);
  const path = data.map((v, i) => v === null ? "" : `${i === 0 || data[i - 1] === null ? "M" : "L"} ${padding + i / (data.length - 1) * (width - 2 * padding)} ${height - padding - v / max * (height - 2 * padding)}`).join(" ");
  return <div className="sparkline" title="Daily measured tokens over 14 calendar days; gaps mean no reading">
    <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true"><path d={path} fill="none" stroke={color} strokeWidth="1.5" /></svg>
  </div>;
}

function buildDriverRows(selectedRows: typeof rows, total: number) {
  const totals = new Map<string, number>();

  for (const row of selectedRows) {
    totals.set(row.driver, (totals.get(row.driver) || 0) + row.total);
  }

  return Array.from(totals, ([label, value]) => ({
    label,
    value,
    share: total ? Math.round((value / total) * 100) : 0,
  }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);
}

interface HeatmapRow {
  date: string;
  total: number;
  claude_code_tokens: number;
  codex_tokens: number;
}

function GitHubHeatmap({
  label,
  rows,
  valueKey,
  maxDay,
  dominantToolMap,
  toolColor,
}: {
  label: string;
  rows: HeatmapRow[];
  valueKey: keyof HeatmapRow;
  maxDay: number;
  dominantToolMap?: Map<string, "claude" | "chatgpt">;
  toolColor?: "claude" | "chatgpt";
}) {
  if (rows.length === 0) return null;

  // Build a map of date → value
  const dateValues = new Map(rows.map((r) => [r.date, r[valueKey] as number]));

  const endDate = new Date(`${rows[rows.length - 1].date}T00:00:00Z`);

  // Walk the grid on UTC-anchored dates, and back up to the Monday of the first
  // week. The cell keys below are produced with toISOString(), so a UTC anchor
  // keeps weekday, month label and key reading off one clock; a local anchor
  // makes all three depend on the viewer's zone and drift from the prerender.
  const adjustedStart = new Date(`${rows[0].date}T00:00:00Z`);
  const daysToMonday = (adjustedStart.getUTCDay() + 6) % 7; // Convert Sun=0 to Mon=0
  adjustedStart.setUTCDate(adjustedStart.getUTCDate() - daysToMonday);

  // Build a 2D grid: rows = days of week (Mon-Sun), columns = weeks
  const weeks: (string | null)[][] = [];
  const currentDate = new Date(adjustedStart);

  while (currentDate <= endDate) {
    const week: (string | null)[] = [];
    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
      const dateStr = currentDate.toISOString().slice(0, 10);
      week.push(dateStr);
      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }
    weeks.push(week);
  }

  const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  // Track month starts: which week index has the 1st of a month
  const monthStarts = new Map<number, string>(); // weekIdx -> month name
  const seenMonths = new Set<string>(); // "YYYY-MM" to avoid duplicates
  weeks.forEach((week, weekIdx) => {
    week.forEach((dateStr) => {
      if (dateStr) {
        const date = new Date(dateStr);
        if (date.getUTCDate() === 1) {
          const monthKey = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
          if (!seenMonths.has(monthKey)) {
            const monthName = date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
            monthStarts.set(weekIdx, monthName);
            seenMonths.add(monthKey);
          }
        }
      }
    });
  });

  return (
    <div className="gitHubHeatmapSection">
      <div className="gitHubHeatmapLabel">{label}</div>
      <div className="gitHubHeatmapContainer">
        {/* Month labels above the grid */}
        <div className="gitHubHeatmapMonths">
          <div className="gitHubMonthSpacer" />
          <div className="gitHubMonthRow">
            {weeks.map((_, weekIdx) => (
              <div key={`month-${weekIdx}`} className="gitHubMonthCell">
                {monthStarts.has(weekIdx) && (
                  <span className="gitHubMonthLabel">{monthStarts.get(weekIdx)}</span>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="gitHubHeatmapOuter">
          {/* Day labels on the left */}
          <div className="gitHubHeatmapAxisLabels">
            {dayLabels.map((day) => (
              <div key={day} className="gitHubHeatmapAxisLabel">
                {day}
              </div>
            ))}
          </div>

          {/* Grid of weeks */}
          <div className="gitHubHeatmapGrid">
            {weeks.map((week, weekIdx) => (
              <div key={weekIdx} className="gitHubWeekColumn">
                {week.map((dateStr, dayIdx) => {
                  const value = dateStr ? (dateValues.get(dateStr) as number) || 0 : 0;
                  const level = value > 0 ? logHeatLevel(value, maxDay) : -1;
                  const dominantTool = dateStr ? dominantToolMap?.get(dateStr) : undefined;
                  const heatClass = level >= 0
                    ? dominantTool
                      ? `heat${dominantTool}${level}`
                      : toolColor
                      ? `heat${toolColor}${level}`
                      : `heat${level}`
                    : "empty";
                  return (
                    <span
                      key={`${weekIdx}-${dayIdx}`}
                      className={`gitHubCell ${heatClass}`}
                      title={dateStr ? `${dateStr}: ${formatTokens(value)}` : ""}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
