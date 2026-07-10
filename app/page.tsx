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
        <div>
          <p className="eyebrow">Token burn dashboard</p>
          <h1>Lloyd's token usage.</h1>
          <p className="lead">
            Exact logs from Claude Code and Codex, plus labeled estimates for chat tools.
            Updated hourly. What should the computer do next?
          </p>
        </div>
        <div className="range" aria-label="Select time range">
          {windows.map((windowOption) => (
            <button
              key={windowOption.key}
              type="button"
              aria-pressed={windowKey === windowOption.key}
              onClick={() => setWindowKey(windowOption.key)}
            >
              {windowOption.label}
            </button>
          ))}
        </div>
      </section>

      <section className="stats" aria-label="Token burn summary">
        <Metric label="Total burn" value={formatTokens(total)} note="selected window" />
        <Metric label="Peak day" value={formatTokens(peakDay?.total || 0)} note={peakDay?.date || "n/a"} />
        <Metric label="7d average" value={formatTokens(lastAverage)} note="moving average" />
        <Metric label="Active days" value={`${selectedRows.length}`} note="rows in view" />
      </section>

      <section className="gaugeRow">
        <BurnGauges selectedRows={selectedRows} windowKey={windowKey} />
      </section>

      <section className="grid">
        <Panel
          label="Daily burn"
          title="Heatmap"
          note="Log color scale so quiet days and spikes can share one surface."
        >
          <div className="heatmap" aria-label="Daily token burn heatmap">
            {selectedRows.map((row) => (
              <span
                key={row.date}
                className={`cell heat${logHeatLevel(row.total, maxDay)}`}
                title={`${row.date}: ${formatTokens(row.total)} tokens, ${row.driver}`}
              />
            ))}
          </div>
          <div className="legend" aria-hidden>
            <span>less</span>
            {[0, 1, 2, 3, 4, 5].map((level) => (
              <i key={level} className={`heat${level}`} />
            ))}
            <span>more</span>
          </div>
        </Panel>

        <Panel
          label="Weekly trend"
          title="Log-scaled trend"
          note="A smooth read on whether usage is getting sharper or merely larger."
        >
          <div className="trend">
            <svg viewBox="0 0 720 260" role="img" aria-label="Weekly token burn trend line">
              <path d="M30 40H690M30 120H690M30 200H690" stroke="rgba(240,236,228,0.12)" />
              <path d={path} fill="none" stroke="var(--accent)" strokeWidth="5" strokeLinecap="round" />
            </svg>
          </div>
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
                <th>Codex exact</th>
                <th>Claude Code exact</th>
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
  const latestDate = selectedRows.at(-1)?.date ?? "";
  const weekStart = latestDate
    ? new Date(new Date(latestDate).getTime() - 6 * 86400000).toISOString().slice(0, 10)
    : "";

  const todayRows = selectedRows.filter((r) => r.date === latestDate);
  const weekRows = selectedRows.filter((r) => r.date >= weekStart);

  const fmtDate = (d: string) =>
    d ? new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";

  const claudeAll = sumSource(selectedRows, "claude_code_tokens");
  const codexAll = sumSource(selectedRows, "codex_tokens");
  const scaleMax = Math.max(claudeAll, codexAll, 1);
  const logFill = (v: number) => (v > 0 ? Math.log10(v + 1) / Math.log10(scaleMax + 1) : 0);

  const rangeLabel = windows.find((w) => w.key === windowKey)?.label ?? "Range";
  const weekLabel =
    weekRows.length > 0
      ? `${fmtDate(weekRows[0].date)} – ${fmtDate(weekRows.at(-1)!.date)}`
      : "no data";

  const periods = [
    { label: "Today", sublabel: fmtDate(latestDate), rows: todayRows },
    { label: "This week", sublabel: weekLabel, rows: weekRows },
    { label: rangeLabel, sublabel: `${selectedRows.length} days`, rows: selectedRows },
  ];

  const sources: Array<{ key: "claude_code_tokens" | "codex_tokens"; label: string; color: string }> = [
    { key: "claude_code_tokens", label: "Claude Code", color: "var(--accent)" },
    { key: "codex_tokens", label: "Codex", color: "var(--good)" },
  ];

  return (
    <article className="panel">
      <div className="panelHeader">
        <div>
          <p className="label">Exact sources · by period</p>
          <h2>Today · Week · Range</h2>
        </div>
        <p>Arc fills log-scaled to peak exact usage in selected range. Chat estimates excluded.</p>
      </div>
      <div className="burnGaugesWrap">
        {sources.map(({ key, label, color }) => (
          <div key={label} className="burnGaugesSourceGroup">
            <p className="burnGaugesSourceLabel" style={{ color }}>{label}</p>
            <div className="burnGaugesCells">
              {periods.map((period) => {
                const value = period.rows.reduce((s, r) => s + r[key], 0);
                return (
                  <div key={period.label} className="burnGaugesCell">
                    <div className="burnGaugesPeriodLabel">
                      <strong>{period.label}</strong>
                      <span>{period.sublabel}</span>
                    </div>
                    <MiniGauge value={value} fill={logFill(value)} color={color} />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function MiniGauge({ value, fill, color }: { value: number; fill: number; color: string }) {
  const cx = 80, cy = 76, ro = 64, ri = 44;

  const toRad = (d: number) => (d * Math.PI) / 180;
  const pt = (r: number, deg: number) => ({
    x: +(cx + r * Math.cos(toRad(deg))).toFixed(2),
    y: +(cy - r * Math.sin(toRad(deg))).toFixed(2),
  });
  const ringPath = (startDeg: number, endDeg: number) => {
    if (startDeg - endDeg < 0.2) return "";
    const large = startDeg - endDeg > 180 ? 1 : 0;
    const os = pt(ro, startDeg), oe = pt(ro, endDeg);
    const is = pt(ri, endDeg), ie = pt(ri, startDeg);
    return `M ${os.x} ${os.y} A ${ro} ${ro} 0 ${large} 0 ${oe.x} ${oe.y} L ${is.x} ${is.y} A ${ri} ${ri} 0 ${large} 0 ${ie.x} ${ie.y} Z`;
  };

  const bgPath = ringPath(180, 0);
  const fillPath = fill > 0.005 ? ringPath(180, 180 - fill * 180) : "";

  return (
    <div className="miniGauge">
      <svg viewBox="0 0 160 88" aria-hidden="true">
        <path d={bgPath} fill="rgba(240,236,228,0.07)" />
        {fillPath && <path d={fillPath} fill={color} opacity={0.9} />}
      </svg>
      <div className="miniGaugeValue">{formatTokens(value)}</div>
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
