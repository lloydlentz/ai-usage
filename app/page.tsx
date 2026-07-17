"use client";

import { useMemo, useState } from "react";

import rawRows from "../data/daily-burn.json";
import meta from "../data/meta.json";
import { normalizeRows, sourceColumns, sumSource } from "../lib/burn-data";
import { getWindowRows, type WindowKey, windows } from "../lib/date-windows";
import {
  fermiScale,
  formatTokens,
  logHeatLevel,
  movingAverage7,
  sumTokens,
  weeklyTotals,
} from "../lib/token-math";

const rows = normalizeRows(rawRows);

export default function TokenBurnDashboard() {
  const [windowKey, setWindowKey] = useState<WindowKey>("180");

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
  const weekly = weeklyTotals(selectedRows);
  const path = buildTrendPath(weekly.map((week) => week.total));
  const sourceTotal = sourceColumns.reduce((sum, source) => sum + sumSource(selectedRows, source.key), 0);
  const tableRows = selectedRows.slice(-30).reverse();

  return (
    <main className="page">
      <section className="hero">
        <p className="eyebrow">Token burn dashboard</p>
        <h1>Lloyd's token usage.</h1>
        <p className="lead">
          Data from Claude and ChatGPT logs. Updated hourly.
        </p>
      </section>

      <section className="gaugeAndCalendarRow">
        <div className="gaugePanelContainer">
          <BurnGauges selectedRows={selectedRows} windowKey={windowKey} />
        </div>
        <Panel
          label="Daily burn"
          title="Activity calendar"
          note="Log color scale so quiet days and spikes can share one surface."
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
        Last refreshed: {new Date(meta.refreshed_at).toLocaleString("en-US", {
          month: "short", day: "numeric", year: "numeric",
          hour: "numeric", minute: "2-digit", timeZoneName: "short",
        })}
      </p>
    </main>
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

function BurnGauges({ selectedRows, windowKey }: { selectedRows: typeof rows; windowKey: WindowKey }) {
  const today = new Date().toISOString().slice(0, 10);
  const weekStart = new Date(new Date(today).getTime() - 6 * 86400000).toISOString().slice(0, 10);

  const todayRows = selectedRows.filter((r) => r.date === today);
  const weekRows = selectedRows.filter((r) => r.date >= weekStart);

  // Calculate max daily usage for each source to scale gauges
  const claudeMaxDaily = Math.max(...selectedRows.map((r) => r.claude_code_tokens), 1);
  const codexMaxDaily = Math.max(...selectedRows.map((r) => r.codex_tokens), 1);

  const claudeToday = sumSource(todayRows, "claude_code_tokens");
  const codexToday = sumSource(todayRows, "codex_tokens");
  const claudeWeek = sumSource(weekRows, "claude_code_tokens");
  const codexWeek = sumSource(weekRows, "codex_tokens");
  const claudeTotal = sumSource(selectedRows, "claude_code_tokens");
  const codexTotal = sumSource(selectedRows, "codex_tokens");

  const claudeFill = claudeToday / claudeMaxDaily;
  const codexFill = codexToday / codexMaxDaily;

  const claudeHistory = selectedRows.map((r) => r.claude_code_tokens);
  const codexHistory = selectedRows.map((r) => r.codex_tokens);

  const sources = [
    { label: "Claude", color: "var(--accent)", today: claudeToday, week: claudeWeek, total: claudeTotal, fill: claudeFill, history: claudeHistory },
    { label: "ChatGPT", color: "var(--good)", today: codexToday, week: codexWeek, total: codexTotal, fill: codexFill, history: codexHistory },
  ];

  return (
    <article className="panel">
      <div className="panelHeader">
        <div>
          <p className="label">Tool use</p>
        </div>
        <p>Today's token usage as a percentage of each tool's peak daily usage.</p>
      </div>
      <div className="toolGaugesWrap">
        {sources.map(({ label, color, today, week, total, fill, history }) => (
          <div key={label} className="toolGaugeGroup">
            <p className="toolGaugeLabel" style={{ color }}>{label}</p>
            <MiniGauge value={today} fill={fill} color={color} />
            <div className="toolGaugeSummary">
              <div>This week: <strong>{formatTokens(week)}</strong></div>
              <div>Total: <strong>{formatTokens(total)}</strong></div>
            </div>
            <Sparkline data={history} color={color} />
          </div>
        ))}
      </div>
    </article>
  );
}

function MiniGauge({ value, fill, color }: { value: number; fill: number; color: string }) {
  const cx = 80, cy = 76, r = 58, sw = 11;
  const circ = Math.PI * r;
  // Semicircle from left (180°) clockwise through top to right (0°)
  const arcD = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;

  const toRad = (d: number) => (d * Math.PI) / 180;
  const needleDeg = 180 - fill * 180; // 180=left (empty), 0=right (full)
  const needleLen = r - sw / 2 - 3;
  const nx = +(cx + needleLen * Math.cos(toRad(needleDeg))).toFixed(2);
  const ny = +(cy - needleLen * Math.sin(toRad(needleDeg))).toFixed(2);

  // Tick mark spanning the full track width at the 50% (top) position
  const innerR = r - sw / 2, outerR = r + sw / 2;
  const tick = {
    x1: cx.toFixed(2), y1: +(cy - innerR).toFixed(2),
    x2: cx.toFixed(2), y2: +(cy - outerR).toFixed(2),
  };

  return (
    <div className="miniGauge">
      <svg viewBox="0 0 160 90" aria-hidden="true">
        {/* track */}
        <path d={arcD} fill="none" stroke="rgba(240,236,228,0.11)" strokeWidth={sw} strokeLinecap="round" />
        {/* fill */}
        <path
          d={arcD} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" opacity={0.88}
          strokeDasharray={`${circ} ${circ}`}
          strokeDashoffset={circ - fill * circ}
        />
        {/* mid tick */}
        <line {...tick} stroke="rgba(240,236,228,0.35)" strokeWidth="1.5" />
        {/* needle */}
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="var(--ink)" strokeWidth="2.5" strokeLinecap="round" opacity="0.9" />
        {/* hub */}
        <circle cx={cx} cy={cy} r={4.5} fill="var(--bg)" stroke="var(--ink)" strokeWidth="1.5" opacity="0.9" />
      </svg>
      <div className="miniGaugeValue">{formatTokens(value)}</div>
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

function buildTrendPath(values: number[]) {
  if (values.length === 0) return "";

  const width = 660;
  const height = 190;
  const left = 30;
  const top = 35;
  const max = Math.max(...values, 1);

  const points = values.map((value, index) => {
    const x = left + (values.length === 1 ? width / 2 : (index / (values.length - 1)) * width);
    const normalized = Math.log10(value + 1) / Math.log10(max + 1);
    const y = top + height - normalized * height;
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  });

  return `M${points.join(" L")}`;
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

  const startDate = new Date(rows[0].date);
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
