"use client";
import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from "react";
import type { CostKnowledge } from "../../lib/burn-data";
import { toUtcDate, dayNumber, dayString, moveDateRange, type DateRange } from "../../lib/date-windows";
import { formatTokens } from "../../lib/token-math";
import { CellCost } from "./cost";

interface TimelineRow {
  date: string;
  claude_code_tokens: number;
  codex_tokens: number;
  cost: CostKnowledge;
}

function formatTimelineDate(dateStr: string) {
  return toUtcDate(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const TIMELINE_TOOLTIP_WIDTH = 176;

export function UsageTimeline({ rows, range, onRangeChange }: { rows: TimelineRow[]; range: DateRange; onRangeChange: (range: DateRange) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [tooltipLeftPx, setTooltipLeftPx] = useState(0);
  const railRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: "create" | "move" | "start" | "end"; anchor: number; original: DateRange; rail: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [plotWidth, setPlotWidth] = useState(1400);
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(([entry]) => setPlotWidth(Math.max(280, entry.contentRect.width)));
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  const n = rows.length;

  // Geometry is pure viewBox math, so it is safe to compute before the
  // `n === 0` bail-out below — the measuring effect needs it, and every hook
  // has to run before that early return.
  const W = plotWidth, H = Math.max(180, Math.min(260, W * .21));
  const padL = 44, padR = 18, padT = 12, padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const bounds = { start: rows[0]?.date || range.start, end: rows.at(-1)?.date || range.end };
  const first = dayNumber(bounds.start);
  const last = dayNumber(bounds.end);
  const days = last - first + 1;
  const xAt = useCallback(
    (i: number) => padL + ((dayNumber(rows[i].date) - first + 0.5) / days) * innerW,
    [rows, days, first, innerW],
  );

  const selectedStart = dayNumber(range.start);
  const selectedEnd = dayNumber(range.end);
  const leftFraction = (selectedStart - first) / days;
  const widthFraction = (selectedEnd - selectedStart + 1) / days;

  const pointerDay = (clientX: number, rail: boolean) => {
    const rect = (rail ? railRef.current : svgRef.current)?.getBoundingClientRect();
    if (!rect) return first;
    const fraction = rail ? (clientX - rect.left) / rect.width : (((clientX - rect.left) / rect.width) * W - padL) / innerW;
    return Math.max(first, Math.min(last, first + Math.floor(fraction * days)));
  };
  const begin = (e: PointerEvent<Element>, mode: "create" | "move" | "start" | "end", rail: boolean) => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus();
    const anchor = pointerDay(e.clientX, rail);
    drag.current = { mode, anchor, original: range, rail };
    setDragging(true);
    setHoverIdx(null);
    if (mode === "create") onRangeChange({ start: dayString(anchor), end: dayString(anchor) });
  };
  const move = (e: PointerEvent<Element>) => {
    const active = drag.current;
    if (!active) return;
    const day = pointerDay(e.clientX, active.rail);
    const { original, mode, anchor } = active;
    if (mode === "move") onRangeChange(moveDateRange(original, day - anchor, bounds));
    else if (mode === "start") onRangeChange({ start: dayString(Math.max(first, Math.min(dayNumber(original.start) + day - anchor, dayNumber(original.end)))), end: original.end });
    else if (mode === "end") onRangeChange({ start: original.start, end: dayString(Math.min(last, Math.max(dayNumber(original.end) + day - anchor, dayNumber(original.start)))) });
    else onRangeChange({ start: dayString(Math.min(anchor, day)), end: dayString(Math.max(anchor, day)) });
  };
  const finish = () => { drag.current = null; setDragging(false); };
  const cancel = () => { if (drag.current) onRangeChange(drag.current.original); finish(); };
  const rangeKey = (e: KeyboardEvent<Element>, mode: "move" | "start" | "end") => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(e.key)) return;
    e.preventDefault();
    if (e.key === "Escape") { cancel(); return; }
    const delta = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 7 : 1);
    if (mode === "move") onRangeChange(moveDateRange(range, e.key === "Home" ? first - selectedStart : e.key === "End" ? last - selectedEnd : delta, bounds));
    else if (mode === "start") onRangeChange({ ...range, start: dayString(e.key === "Home" ? first : e.key === "End" ? selectedEnd : Math.max(first, Math.min(selectedEnd, selectedStart + delta))) });
    else onRangeChange({ ...range, end: dayString(e.key === "End" ? last : e.key === "Home" ? selectedStart : Math.max(selectedStart, Math.min(last, selectedEnd + delta))) });
  };

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
    const idx = rows.reduce((best, _, i) => Math.abs(xAt(i) - localX) < Math.abs(xAt(best) - localX) ? i : best, 0);
    setHoverIdx(Math.min(n - 1, Math.max(0, idx)));
  };

  const hovered = hoverIdx !== null ? rows[hoverIdx] : null;

  return (
    <div className="timeline" ref={containerRef} data-start={range.start} data-end={range.end}>
      <h2 className="label usageSectionLabel">Usage timeline</h2>
      <div className="timelineSelectionHeading">
        <div><strong>{formatTimelineDate(range.start)} – {formatTimelineDate(range.end)}</strong><span>{selectedEnd - selectedStart + 1} days selected</span></div>
        <button type="button" onClick={() => onRangeChange(bounds)} disabled={range.start === bounds.start && range.end === bounds.end}>Select all time</button>
      </div>
      <p id="timeline-instructions" className="timelineInstructions">Drag the chart to select dates. Drag the bar to move the range; use its edges to resize.</p>
      <svg
        ref={svgRef}
        className="timelineSvg"
        data-plot-left={padL / W}
        data-plot-width={innerW / W}
        role="slider"
        tabIndex={0}
        aria-label="Daily usage. Use left and right arrows to inspect dates; Home and End jump to the first and last day."
        aria-valuemin={0}
        aria-valuemax={Math.max(0, n - 1)}
        aria-valuenow={hoverIdx ?? 0}
        aria-valuetext={`${rows[hoverIdx ?? 0].date}: Claude Code ${formatTokens(claude[hoverIdx ?? 0])}, Codex ${formatTokens(chatgpt[hoverIdx ?? 0])} tokens`}
        aria-describedby="timeline-instructions"
        onFocus={() => setHoverIdx((i) => i ?? 0)}
        onBlur={() => setHoverIdx(null)}
        onKeyDown={(e) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(e.key)) return;
          e.preventDefault();
          if (e.key === "Escape") setHoverIdx(null);
          else setHoverIdx((i) => e.key === "Home" ? 0 : e.key === "End" ? n - 1 : Math.max(0, Math.min(n - 1, (i ?? 0) + (e.key === "ArrowRight" ? 1 : -1))));
        }}
        viewBox={`0 0 ${W} ${H}`}
        onPointerDown={(e) => begin(e, "create", false)}
        onPointerMove={(e) => { if (drag.current) move(e); else if (e.pointerType !== "touch") updateHover(e.clientX); }}
        onPointerUp={(e) => { move(e); finish(); }}
        onPointerCancel={cancel}
        onLostPointerCapture={finish}
        onPointerLeave={() => setHoverIdx(null)}
      >
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={padL} y1={yAt(v)} x2={W - padR} y2={yAt(v)} className="timelineGrid" />
            <text x={padL - 8} y={yAt(v)} className="timelineAxisLabel" textAnchor="end" dominantBaseline="middle">
              {v === 0 ? "0" : formatTokens(v)}
            </text>
          </g>
        ))}

        {n === 1 ? <g className="timelineSingleDay">
          <rect x={xAt(0) - 12} y={claudeTop[0]} width="24" height={baseline - claudeTop[0]} className="timelineAreaClaude" />
          <rect x={xAt(0) - 12} y={stackTop[0]} width="24" height={claudeTop[0] - stackTop[0]} className="timelineAreaChatgpt" />
        </g> : <>
          <path d={claudePath} className="timelineAreaClaude" />
          <path d={chatgptPath} className="timelineAreaChatgpt" />
        </>}

        <g className="timelineSelectionOverlay" aria-hidden="true">
          <rect x={padL} y={padT} width={leftFraction * innerW} height={innerH} className="timelineOutside" />
          <rect x={padL + (leftFraction + widthFraction) * innerW} y={padT} width={Math.max(0, (1 - leftFraction - widthFraction) * innerW)} height={innerH} className="timelineOutside" />
          <rect x={padL + leftFraction * innerW} y={padT} width={widthFraction * innerW} height={innerH} className="timelineSelectedOutline" />
        </g>

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

      <div className="timelineRangeRail" ref={railRef} style={{ marginLeft: `${padL / W * 100}%`, width: `${innerW / W * 100}%` }}
        onPointerDown={(e) => begin(e, "create", true)} onPointerMove={move} onPointerUp={(e) => { move(e); finish(); }} onPointerCancel={cancel} onLostPointerCapture={finish}>
        <div className="timelineRangeWindow" style={{ left: `${leftFraction * 100}%`, width: `${widthFraction * 100}%` }}>
          <button type="button" className="timelineRangeMove" role="slider" aria-label="Move selected date range" aria-describedby="timeline-keyboard"
            aria-valuemin={first} aria-valuemax={last - (selectedEnd - selectedStart)} aria-valuenow={selectedStart} aria-valuetext={`${range.start} through ${range.end}`}
            onPointerDown={(e) => begin(e, "move", true)} onKeyDown={(e) => rangeKey(e, "move")} title="Drag to move the selected period"><span aria-hidden="true">⠿</span></button>
          <button type="button" className="timelineRangeHandle timelineRangeStart" role="slider" aria-label="Range start" aria-describedby="timeline-keyboard"
            aria-valuemin={first} aria-valuemax={selectedEnd} aria-valuenow={selectedStart} aria-valuetext={range.start}
            onPointerDown={(e) => begin(e, "start", true)} onKeyDown={(e) => rangeKey(e, "start")} title={`Start: ${range.start}`} />
          <button type="button" className="timelineRangeHandle timelineRangeEnd" role="slider" aria-label="Range end" aria-describedby="timeline-keyboard"
            aria-valuemin={selectedStart} aria-valuemax={last} aria-valuenow={selectedEnd} aria-valuetext={range.end}
            onPointerDown={(e) => begin(e, "end", true)} onKeyDown={(e) => rangeKey(e, "end")} title={`End: ${range.end}`} />
        </div>
      </div>
      <span id="timeline-keyboard" className="srOnly">Left and right arrows move one day; Shift moves seven days. Home and End jump to the limits.</span>

      {hovered && !dragging && (
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

      <p className="timelineDataNote">Measured Claude Code and Codex usage, spaced by calendar date. Gaps between recorded days are not proof of zero usage.</p>
      <div className="timelineLegend">
        <span><span className="timelineSwatch timelineSwatchClaude" /> Claude Code</span>
        <span><span className="timelineSwatch timelineSwatchChatgpt" /> Codex</span>
      </div>
    </div>
  );
}
