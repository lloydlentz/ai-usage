"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import rawRows from "../data/daily-burn.json";
import meta from "../data/meta.json";
import { normalizeRows, sourceColumns, sumSource } from "../lib/burn-data";
import { getWindowRows, type WindowKey } from "../lib/date-windows";
import {
  fermiScale,
  formatTokens,
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

function formatRefreshed(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function TokenBurnDashboard() {
  const [windowKey] = useState<WindowKey>("180");
  const [theme, setTheme] = useState<Theme>("ticker");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "ticker" || saved === "printrun") setTheme(saved);
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

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(new Date(today).getTime() - 86400000).toISOString().slice(0, 10);
  const weekStart = new Date(new Date(today).getTime() - 6 * 86400000).toISOString().slice(0, 10);

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

  const toolSources: ToolSource[] = [
    {
      key: "claude", label: "Claude", ticker: "CLDE", color: "var(--accent)",
      today: claudeToday, yesterday: claudeYesterday, week: claudeWeek, total: claudeTotal,
      fill: claudeToday / claudeMaxDaily, history: selectedRows.map((r) => r.claude_code_tokens),
    },
    {
      key: "chatgpt", label: "ChatGPT", ticker: "CGPT", color: "var(--good)",
      today: codexToday, yesterday: codexYesterday, week: codexWeek, total: codexTotal,
      fill: codexToday / codexMaxDaily, history: selectedRows.map((r) => r.codex_tokens),
    },
  ];

  return (
    <main className="page" data-theme={theme}>
      <ThemeToggle theme={theme} onChange={setTheme} />

      {theme === "ticker" ? (
        <TickerHero
          toolSources={toolSources}
          totalToday={totalToday}
          totalYesterday={totalYesterday}
          total={total}
          peakDay={peakDay}
          lastAverage={lastAverage}
          refreshedAt={meta.refreshed_at}
        />
      ) : (
        <PrintRunHero issueNo={selectedRows.length} />
      )}

      <section className="gaugeAndCalendarRow">
        <div className="gaugePanelContainer">
          {theme === "ticker" ? (
            <TickerToolUse sources={toolSources} />
          ) : (
            <PrintRunToolUse sources={toolSources} />
          )}
        </div>
        <Panel
          label="Daily burn"
          title={theme === "ticker" ? "Burn history" : "Usage timeline"}
          note="Claude and ChatGPT stacked by day — the combined height is the total."
        >
          <UsageTimeline rows={selectedRows} />
        </Panel>
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
            {["Total", "Claude", "ChatGPT"].map((label, idx) => (
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
          title="Make the number human"
          note="Approximate comparisons are useful only when the math stays visible."
        >
          <div className="equivalents">
            {fermiScale(total).map((item) => (
              <div key={item.label} className="equivalent">
                <span className="muted">{item.label}</span>
                <strong>{item.value}</strong>
                <span>{item.note}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          label="Peak day"
          title={peakDay?.driver || "No data"}
          note={peakDay?.evidence || "Add evidence notes to explain why a day spiked."}
        >
          <div className="sourceGrid">
            <Metric label="Date" value={peakDay?.date || "n/a"} note="local bucket" />
            <Metric label="Burn" value={formatTokens(peakDay?.total || 0)} note="all sources" />
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
                <th>7d avg</th>
                <th>ChatGPT exact</th>
                <th>Claude exact</th>
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

// --- Ticker theme: hero + tool-use quote board -----------------------------

function TickerHero({
  toolSources,
  totalToday,
  totalYesterday,
  total,
  peakDay,
  lastAverage,
  refreshedAt,
}: {
  toolSources: ToolSource[];
  totalToday: number;
  totalYesterday: number;
  total: number;
  peakDay: (typeof rows)[number] | undefined;
  lastAverage: number;
  refreshedAt: string;
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
    <>
      <div className="tkTape" aria-hidden="true">
        <div className="tkTapeTrack">
          <span className="tkTapeGroup">{tapeItems}</span>
          <span className="tkTapeGroup">{tapeItems}</span>
        </div>
      </div>
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
          Data from Claude and ChatGPT logs, quoted like a burn rate — because that&apos;s exactly what it is.
        </p>
      </section>
    </>
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

function PrintRunHero({ issueNo }: { issueNo: number }) {
  return (
    <section className="hero prHero">
      <span className="prStamp">Issue {String(issueNo).padStart(3, "0")} · Personal Zine</span>
      <div className="prH1Wrap">
        <p className="prGhost" aria-hidden="true">
          Lloyd&apos;s token usage.
        </p>
        <h1 className="prH1">Lloyd&apos;s token usage.</h1>
      </div>
      <p className="lead">
        Data from Claude and ChatGPT logs. Printed hourly, one run at a time — this is issue{" "}
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
}

function formatTimelineDate(dateStr: string) {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const TIMELINE_TOOLTIP_WIDTH = 176;

function UsageTimeline({ rows }: { rows: TimelineRow[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const n = rows.length;
  if (n === 0) return null;

  const W = 760, H = 240;
  const padL = 46, padR = 12, padT = 12, padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const claude = rows.map((r) => r.claude_code_tokens);
  const chatgpt = rows.map((r) => r.codex_tokens);
  const totals = claude.map((v, i) => v + chatgpt[i]);
  const yMax = Math.max(...totals, 1) * 1.08;

  const step = n > 1 ? innerW / (n - 1) : 0;
  const xAt = (i: number) => (n === 1 ? padL + innerW / 2 : padL + i * step);
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

  // Position the tooltip in real pixels (not a % of the container) so its
  // fixed width never overflows a narrow container near either edge.
  let tooltipLeftPx = 0;
  if (hoverIdx !== null && containerRef.current && svgRef.current) {
    const containerRect = containerRef.current.getBoundingClientRect();
    const svgRect = svgRef.current.getBoundingClientRect();
    const scale = svgRect.width / W;
    const pointPx = svgRect.left - containerRect.left + xAt(hoverIdx) * scale;
    tooltipLeftPx = Math.min(
      containerRect.width - TIMELINE_TOOLTIP_WIDTH - 4,
      Math.max(4, pointPx - TIMELINE_TOOLTIP_WIDTH / 2),
    );
  }

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
            Claude <b>{formatTokens(hovered.claude_code_tokens)}</b>
          </div>
          <div className="timelineTooltipRow">
            <span className="timelineSwatch timelineSwatchChatgpt" />
            ChatGPT <b>{formatTokens(hovered.codex_tokens)}</b>
          </div>
          <div className="timelineTooltipRow timelineTooltipTotal">
            Total <b>{formatTokens(hovered.claude_code_tokens + hovered.codex_tokens)}</b>
          </div>
        </div>
      )}

      <div className="timelineLegend">
        <span><span className="timelineSwatch timelineSwatchClaude" /> Claude</span>
        <span><span className="timelineSwatch timelineSwatchChatgpt" /> ChatGPT</span>
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

  const endDate = new Date(rows[rows.length - 1].date);

  // Adjust start date to the Monday of that week
  // Use noon to avoid timezone ambiguity when parsing date strings
  const startDateNoon = new Date(rows[0].date + "T12:00:00");
  const dayOfWeek = startDateNoon.getDay();
  const daysToMonday = (dayOfWeek + 6) % 7; // Convert Sun=0 to Mon=0
  const adjustedStart = new Date(startDateNoon);
  adjustedStart.setDate(adjustedStart.getDate() - daysToMonday);

  // Build a 2D grid: rows = days of week (Mon-Sun), columns = weeks
  const weeks: (string | null)[][] = [];
  let currentDate = new Date(adjustedStart);

  while (currentDate <= endDate) {
    const week: (string | null)[] = [];
    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
      const dateStr = currentDate.toISOString().slice(0, 10);
      week.push(dateStr);
      currentDate.setDate(currentDate.getDate() + 1);
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
        if (date.getDate() === 1) {
          const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
          if (!seenMonths.has(monthKey)) {
            const monthName = date.toLocaleDateString("en-US", { month: "short" });
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
