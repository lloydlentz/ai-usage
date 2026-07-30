"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import rawRows from "../data/daily-burn.json";
import meta from "../data/meta.json";
import {
  emptyByType,
  normalizeRows,
  sourceColumns,
  sumByModel,
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
import { getWindowRows, type WindowKey } from "../lib/date-windows";
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

type Theme = "ticker" | "printrun";
const THEME_STORAGE_KEY = "dashboard-theme";

type ToolSource = {
  key: "claude" | "chatgpt";
  label: string;
  ticker: string;
  color: string;
  today: number;
  yesterday: number;
  week: number;
  total: number;
  fill: number;
  history: number[];
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
  const [windowKey] = useState<WindowKey>("180");
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
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    // SSR-safe hydration correction: this page is a static export, so the first
    // client render must be byte-identical to the prerendered HTML. The stored
    // theme and the viewer's real Chicago day are only knowable on the client,
    // so they can only be applied after mount. Restructuring this to avoid
    // setState-in-effect would reintroduce a hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved === "ticker" || saved === "printrun") setTheme(saved);
    setToday(chicagoDay(new Date()));
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted) localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme, mounted]);

  // Mirror the theme onto <html> so body background (outside .page) matches too.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const selectedRows = useMemo(() => getWindowRows(rows, windowKey), [windowKey]);
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
    selectedRows[0] || rows[0],
  );
  const lastAverage =
    selectedRows.length > 0 ? movingAverage7(selectedRows, selectedRows.length - 1) : 0;
  const drivers = buildDriverRows(selectedRows, total);
  const sourceTotal = sourceColumns.reduce((sum, source) => sum + sumSource(selectedRows, source.key), 0);
  const tableRows = selectedRows.slice(-30).reverse();

  const yesterday = addDays(today, -1);
  const weekStart = addDays(today, -6);

  const todayRows = selectedRows.filter((r) => r.date === today);
  const yesterdayRows = selectedRows.filter((r) => r.date === yesterday);
  const weekRows = selectedRows.filter((r) => r.date >= weekStart);

  const claudeMaxDaily = Math.max(...selectedRows.map((r) => r.claude_code_tokens), 1);
  const codexMaxDaily = Math.max(...selectedRows.map((r) => r.codex_tokens), 1);

  const claudeToday = sumSource(todayRows, "claude_code_tokens");
  const codexToday = sumSource(todayRows, "codex_tokens");
  const claudeYesterday = sumSource(yesterdayRows, "claude_code_tokens");
  const codexYesterday = sumSource(yesterdayRows, "codex_tokens");
  const claudeWeek = sumSource(weekRows, "claude_code_tokens");
  const codexWeek = sumSource(weekRows, "codex_tokens");
  const claudeTotal = sumSource(selectedRows, "claude_code_tokens");
  const codexTotal = sumSource(selectedRows, "codex_tokens");

  const totalToday = todayRows.reduce((sum, r) => sum + r.total, 0);
  const totalYesterday = yesterdayRows.reduce((sum, r) => sum + r.total, 0);

  // The cost side of the ledger. Only measured tokens are ever priced, so the
  // token figure shown beside the dollars counts the same universe — pairing
  // dollars with the all-sources total (which folds in unpriced chat estimates)
  // would make the two numbers describe different things.
  const measured = useMemo(() => sumTokensByType(selectedRows), [selectedRows]);
  const cost = useMemo(() => sumCost(selectedRows), [selectedRows]);
  const modelTotals = useMemo(() => sumByModel(selectedRows), [selectedRows]);
  const measuredTokens = measured.typed + measured.unattributed;
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
      key: "claude", label: "Claude", ticker: "CLDE", color: "var(--accent)",
      today: claudeToday, yesterday: claudeYesterday, week: claudeWeek, total: claudeTotal,
      fill: claudeToday / claudeMaxDaily, history: selectedRows.map((r) => r.claude_code_tokens),
    },
    {
      // Exact Codex CLI tokens. Labelled "Codex", not "ChatGPT": the ChatGPT app
      // is a separate, estimated column and conflating the two made the exact
      // number look like it counted chat usage.
      key: "chatgpt", label: "Codex", ticker: "CDX", color: "var(--good)",
      today: codexToday, yesterday: codexYesterday, week: codexWeek, total: codexTotal,
      fill: codexToday / codexMaxDaily, history: selectedRows.map((r) => r.codex_tokens),
    },
  ];

  return (
    <main className="page" data-theme={theme}>
      <ThemeToggle theme={theme} onChange={setTheme} />

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
            <TickerHeroContent refreshedAt={meta.refreshed_at} />
          ) : (
            <PrintRunHero issueNo={selectedRows.length} refreshedAt={meta.refreshed_at} />
          )}
        </div>
        {theme === "ticker" ? (
          <TickerToolUse sources={toolSources} />
        ) : (
          <PrintRunToolUse sources={toolSources} />
        )}
      </section>

      <section className="timelineRow">
        <Panel
          label="Daily burn"
          title={theme === "ticker" ? "Burn history" : "Usage timeline"}
          note="Claude Code and Codex CLI stacked by day — the combined height is the total."
        >
          <UsageTimeline rows={selectedRows} />
        </Panel>
      </section>

      <section className="ledger" aria-label="Cost beside volume">
        <div className="ledgerFigures">
          <div className="ledgerFigure">
            <p className="label">What it would have cost</p>
            <CostAmount cost={cost} className="ledgerAmount" />
            <p className="ledgerCaption">
              <BasisPill /> Priced at public API rates. This usage ran on flat-rate
              subscriptions, so no one was billed this.
            </p>
          </div>
          <div className="ledgerFigure">
            <p className="label">What it took to get there</p>
            <p className="ledgerAmount">
              <span className="ledgerAmountStack">
                <span className="ledgerGhost" aria-hidden="true">
                  {formatTokens(measuredTokens)}
                </span>
                <span className="ledgerAmountInk">{formatTokens(measuredTokens)}</span>
              </span>
              <span className="ledgerUnit">tokens</span>
            </p>
            <p className="ledgerCaption">
              <span className="pill exact">exact</span> Measured from Claude Code and Codex
              logs. {cacheReadSeg ? formatPct(cacheReadSeg.tokenPct) : "—"} of them were cache
              reads.
            </p>
          </div>
        </div>

        <ShapeShift
          segments={shiftSegments}
          tokenTotal={measured.typed}
          costTotal={costTotal}
          costKind={cost.kind}
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
        <Metric label="7d average" value={formatTokens(lastAverage)} note="moving average" />
        <Metric label="Active days" value={`${selectedRows.length}`} note="rows in view" />
      </section>

      <section className="grid gridCost">
        <Panel
          label="Cost by model"
          title="Where the money went"
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
                      {model.costUsd === null ? "not priced" : formatUsd(model.costUsd)}
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
          title="Which agent spent it"
          note="Chat estimates are never priced — only exact logs carry a cost."
        >
          <div className="driverGrid">
            {(["claude_code", "codex"] as ToolKey[]).map((tool) => {
              const value =
                cost.kind === "priced" || cost.kind === "lower-bound" ? cost.byTool[tool] : undefined;
              const share = costTotal && value !== undefined ? (value / costTotal) * 100 : 0;
              return (
                <div key={tool} className="driver">
                  <strong>{toolLabels[tool]}</strong>
                  <span className="track">
                    <i style={{ width: `${share}%` }} />
                  </span>
                  <span>{value === undefined ? "not priced" : formatUsd(value)}</span>
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
            the rest are estimates only and have nothing to cost.
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
          note="Keep driver labels boring and consistent: shipping, research, review, video, admin."
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
                const originalIndex = selectedRows.findIndex((candidate) => candidate.date === row.date);
                return (
                  <tr key={row.date}>
                    <td>
                      <strong>{row.date}</strong>
                    </td>
                    <td>{formatTokens(row.total)}</td>
                    <td>
                      <CellCost cost={row.cost} />
                    </td>
                    <td>{formatTokens(movingAverage7(selectedRows, originalIndex))}</td>
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

      <p className="footerNote">
        {theme === "ticker"
          ? "● Live · refreshed hourly · "
          : "Run on a laser printer that pretends to be a riso · "}
        Last refreshed:{" "}
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

// --- Cost: the basis qualifier and the four ways a day can be costed --------

/**
 * The qualifier that travels with every dollar figure on the page. It uses the
 * same pill mechanism as the exact/estimated fidelity labels because it answers
 * the same kind of question — how much to trust this number — and because a pill
 * stays attached to the figure when someone crops a screenshot. A footnote
 * would not.
 */
function BasisPill() {
  return (
    <span className="pill counterfactual" title={meta.cost.disclaimer}>
      at API list
    </span>
  );
}

/** Large cost figure. Renders each CostKnowledge state as itself, never as $0. */
function CostAmount({ cost, className }: { cost: CostKnowledge; className?: string }) {
  if (cost.kind === "not-measured") {
    return (
      <p className={className}>
        <span className="ledgerAmountInk costNil">&mdash;</span>
        <span className="ledgerUnit">nothing measured to cost</span>
      </p>
    );
  }

  if (cost.kind === "unknown") {
    return (
      <p className={className}>
        <span className="ledgerAmountInk costNil">Not priced</span>
        <span className="ledgerUnit">
          {cost.unpricedTokens.toLocaleString("en-US")} tokens with no rate
        </span>
      </p>
    );
  }

  const text = formatUsd(cost.usd);
  return (
    <p className={className}>
      {cost.kind === "lower-bound" && <span className="costBound">at least</span>}
      <span className="ledgerAmountStack">
        <span className="ledgerGhost" aria-hidden="true">
          {text}
        </span>
        <span className="ledgerAmountInk">{text}</span>
      </span>
    </p>
  );
}

/** Compact cost for table cells. Same four states, one line. */
function CellCost({ cost }: { cost: CostKnowledge }) {
  if (cost.kind === "not-measured") {
    return <span className="muted" title="Estimates only — there was no measured usage to price">&mdash;</span>;
  }
  if (cost.kind === "unknown") {
    return (
      <span className="muted" title={`${cost.unpricedTokens.toLocaleString("en-US")} tokens with no rate card`}>
        not priced
      </span>
    );
  }
  return (
    <span title={cost.kind === "lower-bound" ? "Lower bound — some tokens on this day are unpriced" : undefined}>
      {cost.kind === "lower-bound" ? "≥ " : ""}
      {formatUsd(cost.usd)}
    </span>
  );
}

/** States plainly what the headline figure is missing, when it is missing any. */
function UnpricedNote({ cost, unattributed }: { cost: CostKnowledge; unattributed: number }) {
  const unpriced = cost.kind === "unknown" || cost.kind === "lower-bound" ? cost.unpricedTokens : 0;
  if (unpriced === 0 && unattributed === 0) return null;

  return (
    <p className="ledgerWarn">
      <span className="pill unpriced">lower bound</span>
      {unpriced.toLocaleString("en-US")} tokens have no rate
      {unattributed >= unpriced
        ? " and no recorded model or type split"
        : unattributed > 0
        ? `, ${unattributed.toLocaleString("en-US")} of them with no recorded model or type split`
        : ""}
      . They count as nothing in the figures above, so the real cost is higher than the one
      shown.
    </p>
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
   less pinches in. `labelMinH` is the height a node needs before it can carry
   its own name without colliding with its neighbours. */
const SANKEY = {
  w: 1000,
  h: 454,
  nodeW: 20,
  gap: 5,
  lx: 168,
  rx: 812,
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

function ShapeShift({
  segments,
  tokenTotal,
  costTotal,
  costKind,
}: {
  segments: ShiftSegment[];
  tokenTotal: number;
  costTotal: number;
  costKind: CostKnowledge["kind"];
}) {
  const [active, setActive] = useState<TokenType | null>(null);

  const tokenW = displayWidths(segments.map((s) => s.tokens));
  const costW = displayWidths(segments.map((s) => s.cost));

  const dim = (type: TokenType) => (active && active !== type ? 0.14 : 1);

  const priced = costKind === "priced" || costKind === "lower-bound";

  const left = stackNodes(tokenW);
  const right = stackNodes(costW);

  return (
    <div className="shift">
      <div className="shiftHeads">
        <div className="shiftHead">
          <span className="shiftRowName">By volume</span>
          <span className="shiftRowValue">{formatTokens(tokenTotal)} tokens</span>
        </div>
        <div className="shiftHead shiftHeadRight">
          <span className="shiftRowName">By cost</span>
          <span className="shiftRowValue">
            {priced ? formatUsd(costTotal) : "not priced"} <BasisPill />
          </span>
        </div>
      </div>

      <svg
        className="shiftFlow"
        viewBox={`0 0 ${SANKEY.w} ${SANKEY.h}`}
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
            />
          );
        })}

        {segments.map((seg, i) => {
          const l = left[i];
          const r = right[i];
          return (
            <g key={seg.type} opacity={dim(seg.type)}>
              <rect x={SANKEY.lx} y={l.top} width={SANKEY.nodeW} height={l.h} fill={typeVar(seg.type)}>
                <title>{`${seg.label}: ${formatTokens(seg.tokens)} tokens (${formatPct(seg.tokenPct)} of volume)`}</title>
              </rect>
              <rect x={SANKEY.rx} y={r.top} width={SANKEY.nodeW} height={r.h} fill={typeVar(seg.type)}>
                <title>{`${seg.label}: ${formatUsd(seg.cost)} at API list (${formatPct(seg.costPct)} of cost)`}</title>
              </rect>

              {/* A node names itself only when it is tall enough to hold the
                  text. On this data that labels cache read on the left and the
                  four that actually cost something on the right — which is the
                  point of the chart. The legend carries the rest. */}
              {l.h >= SANKEY.labelMinH && (
                <text
                  className="shiftNodeLabel"
                  x={SANKEY.lx - 14}
                  y={l.top + l.h / 2}
                  textAnchor="end"
                  dominantBaseline="middle"
                >
                  <tspan>{seg.label}</tspan>
                  <tspan className="shiftNodePct" dx="8">
                    {formatPct(seg.tokenPct)}
                  </tspan>
                </text>
              )}
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
      </svg>

      <ul className="shiftLegend">
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
              <span className="shiftKeyPct">{formatPct(seg.tokenPct)}</span>
              <span className="shiftKeyArrow" aria-hidden="true">
                →
              </span>
              <span className="shiftKeyPct shiftKeyCost">{priced ? formatPct(seg.costPct) : "—"}</span>
            </button>
          </li>
        ))}
        <li className="shiftLegendHead" aria-hidden="true">
          share of volume → share of cost
        </li>
      </ul>
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

  const tapeItems = (
    <>
      {toolSources.map((s) => {
        const d = pctDelta(s.today, s.yesterday);
        return (
          <span className="tkTapeItem" key={s.ticker}>
            {s.ticker} <b>{formatTokens(s.today)}</b>{" "}
            <span className={d >= 0 ? "tkUp" : "tkDown"}>
              {d >= 0 ? "▲" : "▼"} {Math.abs(d).toFixed(1)}%
            </span>
          </span>
        );
      })}
      <span className="tkTapeItem">
        TOTAL <b>{formatTokens(total)}</b>{" "}
        <span className={totalDelta >= 0 ? "tkUp" : "tkDown"}>
          {totalDelta >= 0 ? "▲" : "▼"} {Math.abs(totalDelta).toFixed(1)}%
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

function TickerHeroContent({ refreshedAt }: { refreshedAt: string }) {
  return (
    <section className="hero tkHero">
      <div className="tkHeroRow">
        <div>
          <p className="eyebrow">Token Burn — Daily Sheet</p>
          <h1>Lloyd&apos;s token usage.</h1>
        </div>
        <div className="tkAsOf">
          <span className="tkLive">● LIVE</span> · refreshed hourly
          <br />
          last tick {formatRefreshed(refreshedAt)}
        </div>
      </div>
      <p className="lead">
        Data from Claude Code and Codex logs, quoted like a burn rate — because that&apos;s exactly what it is.
      </p>
    </section>
  );
}

function TickerToolUse({ sources }: { sources: ToolSource[] }) {
  return (
    <article className="panel tkToolUse">
      <div className="panelHeader">
        <div>
          <p className="label">Tool use</p>
        </div>
        <p>Quoted against each tool&apos;s all-time daily peak.</p>
      </div>
      <div className="tkQuoteBoard">
        {sources.map((s) => {
          const d = pctDelta(s.today, s.yesterday);
          return (
            <div key={s.key} className="tkQuoteEntry">
              <div className="tkQuoteRow">
                <div className="tkSym">
                  <span className="tkSymTicker" style={{ color: s.color }}>
                    {s.ticker}
                  </span>
                  <span className="tkSymName">{s.label}</span>
                </div>
                <CandleSpark data={s.history} color={s.color} />
                <div className="tkQuoteRight">
                  <span className="tkLast">{Math.round(s.fill * 100)}%</span>
                  <span className={`tkDelta ${d >= 0 ? "tkUp" : "tkDown"}`}>
                    {d >= 0 ? "▲" : "▼"} vs yesterday
                  </span>
                </div>
              </div>
              <div className="tkQuoteSub">
                <span>
                  WEEK <b>{formatTokens(s.week)}</b>
                </span>
                <span>
                  TOTAL <b>{formatTokens(s.total)}</b>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function CandleSpark({ data, color }: { data: number[]; color: string }) {
  const recent = data.slice(-14);
  if (recent.length < 2) return null;
  const max = Math.max(...recent, 1);
  return (
    <div className="tkCandles">
      {recent.map((v, i) => (
        <span
          key={i}
          className="tkCandle"
          style={{ height: `${(v / max) * 100}%`, background: color }}
        />
      ))}
    </div>
  );
}

// --- Print Run theme: hero + tool-use ring gauges ---------------------------

function PrintRunHero({ issueNo, refreshedAt }: { issueNo: number; refreshedAt: string }) {
  return (
    <section className="hero prHero">
      <div className="prStampRow">
        <span className="prStamp">Issue {String(issueNo).padStart(3, "0")} · Personal Zine</span>
        <span className="prMeta">Updated {formatRefreshed(refreshedAt)}</span>
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

function PrintRunToolUse({ sources }: { sources: ToolSource[] }) {
  return (
    <article className="panel prToolUse">
      <span className="prTapeCorner" aria-hidden="true" />
      <div className="panelHeader">
        <div>
          <p className="label">Tool use</p>
        </div>
        <p>Today&apos;s token usage as a percentage of each tool&apos;s peak daily usage.</p>
      </div>
      <div className="prTools">
        {sources.map((s) => (
          <div key={s.key} className="prToolBlock">
            <RingGauge fill={s.fill} color={s.color} />
            <p className="prToolName" style={{ color: s.color }}>
              {s.label}
            </p>
            <p className="prToolSub">
              of peak day
              <br />
              week <b>{formatTokens(s.week)}</b> · total <b>{formatTokens(s.total)}</b>
            </p>
            <Sparkline data={s.history} color={s.color} />
          </div>
        ))}
      </div>
    </article>
  );
}

function RingGauge({ fill, color }: { fill: number; color: string }) {
  const r = 46;
  const circ = 2 * Math.PI * r;
  const clamped = Math.min(Math.max(fill, 0), 1);
  const offset = circ * (1 - clamped);
  return (
    <div className="prRingWrap">
      <svg viewBox="0 0 108 108" width="108" height="108" aria-hidden="true">
        <circle cx="54" cy="54" r={r} fill="none" stroke="var(--line)" strokeWidth="2.5" opacity="0.3" />
        <circle
          cx="54" cy="54" r={r} fill="none" stroke={color} strokeWidth="7"
          strokeDasharray={`${circ} ${circ}`} strokeDashoffset={offset} strokeLinecap="butt"
          transform="rotate(-90 54 54)"
        />
      </svg>
      <span className="prRingPct">{Math.round(clamped * 100)}%</span>
    </div>
  );
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;

  const width = 120, height = 24;
  const padding = 1;
  const max = Math.max(...data, 1);
  const min = 0;

  const points = data.map((v, i) => {
    const x = padding + (i / (data.length - 1)) * (width - 2 * padding);
    const y = height - padding - ((v - min) / (max - min)) * (height - 2 * padding);
    return `${x},${y}`;
  }).join(' ');

  return (
    <div className="sparkline">
      <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" opacity="0.6" />
      </svg>
    </div>
  );
}

interface TimelineRow {
  date: string;
  claude_code_tokens: number;
  codex_tokens: number;
  cost: CostKnowledge;
}

function formatTimelineDate(dateStr: string) {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const TIMELINE_TOOLTIP_WIDTH = 176;

function UsageTimeline({ rows }: { rows: TimelineRow[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [tooltipLeftPx, setTooltipLeftPx] = useState(0);

  const n = rows.length;

  // Geometry is pure viewBox math, so it is safe to compute before the
  // `n === 0` bail-out below — the measuring effect needs it, and every hook
  // has to run before that early return.
  const W = 1400, H = 300;
  const padL = 52, padR = 16, padT = 12, padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const step = n > 1 ? innerW / (n - 1) : 0;
  const xAt = useCallback(
    (i: number) => (n === 1 ? padL + innerW / 2 : padL + i * step),
    [n, padL, innerW, step],
  );

  // Position the tooltip in real pixels (not a % of the container) so its
  // fixed width never overflows a narrow container near either edge.
  //
  // The measurement has to come from the DOM, and refs must not be read during
  // render (they are null on the first pass, and writing one never schedules a
  // re-render — so rendering from them would position the tooltip using the
  // *previous* layout). Measure in a layout effect instead: it runs after the
  // hover commit but before paint, so the tooltip never visibly jumps. Deps are
  // all numbers plus a memoized `xAt`, so this cannot re-fire on its own setState.
  useLayoutEffect(() => {
    if (hoverIdx === null) return;
    const container = containerRef.current;
    const svg = svgRef.current;
    if (!container || !svg) return;
    const containerRect = container.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    // The SVG scales to its container, so map viewBox units into CSS pixels.
    const scale = svgRect.width / W;
    const pointPx = svgRect.left - containerRect.left + xAt(hoverIdx) * scale;
    setTooltipLeftPx(
      Math.min(
        containerRect.width - TIMELINE_TOOLTIP_WIDTH - 4,
        Math.max(4, pointPx - TIMELINE_TOOLTIP_WIDTH / 2),
      ),
    );
  }, [hoverIdx, xAt, W]);

  if (n === 0) return null;

  const claude = rows.map((r) => r.claude_code_tokens);
  const chatgpt = rows.map((r) => r.codex_tokens);
  const totals = claude.map((v, i) => v + chatgpt[i]);
  const yMax = Math.max(...totals, 1) * 1.08;

  const yAt = (v: number) => padT + innerH - (v / yMax) * innerH;
  const baseline = padT + innerH;

  const claudeTop = claude.map((v) => yAt(v));
  const stackTop = totals.map((v) => yAt(v));

  const topLine = (ys: number[]) => ys.map((y, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${y.toFixed(1)}`).join(" ");

  const claudePath = `${topLine(claudeTop)} L ${xAt(n - 1).toFixed(1)} ${baseline} L ${xAt(0).toFixed(1)} ${baseline} Z`;
  const chatgptPath =
    `${topLine(stackTop)} L ${xAt(n - 1).toFixed(1)} ${claudeTop[n - 1].toFixed(1)} ` +
    claudeTop
      .map((y, i) => n - 1 - i)
      .map((i) => `L ${xAt(i).toFixed(1)} ${claudeTop[i].toFixed(1)}`)
      .join(" ") +
    " Z";

  const yTicks = [0, yMax / 2, yMax];
  const xTickIdx = Array.from(
    new Set([0, Math.round((n - 1) * 0.25), Math.round((n - 1) * 0.5), Math.round((n - 1) * 0.75), n - 1]),
  );

  const updateHover = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const localX = ((clientX - rect.left) / rect.width) * W;
    const idx = step > 0 ? Math.round((localX - padL) / step) : 0;
    setHoverIdx(Math.min(n - 1, Math.max(0, idx)));
  };

  const hovered = hoverIdx !== null ? rows[hoverIdx] : null;

  return (
    <div className="timeline" ref={containerRef}>
      <svg
        ref={svgRef}
        className="timelineSvg"
        viewBox={`0 0 ${W} ${H}`}
        onMouseMove={(e) => updateHover(e.clientX)}
        onMouseLeave={() => setHoverIdx(null)}
        onTouchMove={(e) => e.touches[0] && updateHover(e.touches[0].clientX)}
        onTouchEnd={() => setHoverIdx(null)}
      >
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={padL} y1={yAt(v)} x2={W - padR} y2={yAt(v)} className="timelineGrid" />
            <text x={padL - 8} y={yAt(v)} className="timelineAxisLabel" textAnchor="end" dominantBaseline="middle">
              {v === 0 ? "0" : formatTokens(v)}
            </text>
          </g>
        ))}

        <path d={claudePath} className="timelineAreaClaude" />
        <path d={chatgptPath} className="timelineAreaChatgpt" />

        {xTickIdx.map((i) => (
          <text key={i} x={xAt(i)} y={H - 6} className="timelineAxisLabel" textAnchor="middle">
            {formatTimelineDate(rows[i].date)}
          </text>
        ))}

        {hoverIdx !== null && (
          <g>
            <line
              x1={xAt(hoverIdx)} y1={padT} x2={xAt(hoverIdx)} y2={baseline}
              className="timelineCrosshair"
            />
            <circle cx={xAt(hoverIdx)} cy={claudeTop[hoverIdx]} r="3.5" className="timelineDotClaude" />
            <circle cx={xAt(hoverIdx)} cy={stackTop[hoverIdx]} r="3.5" className="timelineDotChatgpt" />
          </g>
        )}
      </svg>

      {hovered && (
        <div className="timelineTooltip" style={{ left: `${tooltipLeftPx}px` }}>
          <div className="timelineTooltipDate">{formatTimelineDate(hovered.date)}</div>
          <div className="timelineTooltipRow">
            <span className="timelineSwatch timelineSwatchClaude" />
            Claude Code <b>{formatTokens(hovered.claude_code_tokens)}</b>
          </div>
          <div className="timelineTooltipRow">
            <span className="timelineSwatch timelineSwatchChatgpt" />
            Codex <b>{formatTokens(hovered.codex_tokens)}</b>
          </div>
          <div className="timelineTooltipRow timelineTooltipTotal">
            Total <b>{formatTokens(hovered.claude_code_tokens + hovered.codex_tokens)}</b>
          </div>
          <div className="timelineTooltipRow timelineTooltipCost">
            <span className="timelineTooltipCostLabel">Cost at API list</span>
            <b>
              <CellCost cost={hovered.cost} />
            </b>
          </div>
        </div>
      )}

      <div className="timelineLegend">
        <span><span className="timelineSwatch timelineSwatchClaude" /> Claude Code</span>
        <span><span className="timelineSwatch timelineSwatchChatgpt" /> Codex</span>
      </div>
    </div>
  );
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
