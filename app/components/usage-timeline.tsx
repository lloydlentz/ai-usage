"use client";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { CostKnowledge } from "../../lib/burn-data";
import { toUtcDate } from "../../lib/date-windows";
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

export function UsageTimeline({ rows }: { rows: TimelineRow[] }) {
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

  const first = rows.length ? toUtcDate(rows[0].date).getTime() : 0;
  const span = rows.length ? toUtcDate(rows[rows.length - 1].date).getTime() - first : 0;
  const xAt = useCallback(
    (i: number) => span === 0 ? padL + innerW / 2 : padL + ((toUtcDate(rows[i].date).getTime() - first) / span) * innerW,
    [rows, span, first, innerW],
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
    const idx = rows.reduce((best, _, i) => Math.abs(xAt(i) - localX) < Math.abs(xAt(best) - localX) ? i : best, 0);
    setHoverIdx(Math.min(n - 1, Math.max(0, idx)));
  };

  const hovered = hoverIdx !== null ? rows[hoverIdx] : null;

  return (
    <div className="timeline" ref={containerRef}>
      <svg
        ref={svgRef}
        className="timelineSvg"
        role="slider"
        tabIndex={0}
        aria-label="Daily usage. Use left and right arrows to inspect dates; Home and End jump to the first and last day."
        aria-valuemin={0}
        aria-valuemax={Math.max(0, n - 1)}
        aria-valuenow={hoverIdx ?? 0}
        aria-valuetext={`${rows[hoverIdx ?? 0].date}: Claude Code ${formatTokens(claude[hoverIdx ?? 0])}, Codex ${formatTokens(chatgpt[hoverIdx ?? 0])} tokens`}
        onFocus={() => setHoverIdx((i) => i ?? 0)}
        onBlur={() => setHoverIdx(null)}
        onKeyDown={(e) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(e.key)) return;
          e.preventDefault();
          if (e.key === "Escape") setHoverIdx(null);
          else setHoverIdx((i) => e.key === "Home" ? 0 : e.key === "End" ? n - 1 : Math.max(0, Math.min(n - 1, (i ?? 0) + (e.key === "ArrowRight" ? 1 : -1))));
        }}
        onTouchStart={(e) => e.touches[0] && updateHover(e.touches[0].clientX)}
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

        {n === 1 ? <g className="timelineSingleDay">
          <rect x={xAt(0) - 12} y={claudeTop[0]} width="24" height={baseline - claudeTop[0]} className="timelineAreaClaude" />
          <rect x={xAt(0) - 12} y={stackTop[0]} width="24" height={claudeTop[0] - stackTop[0]} className="timelineAreaChatgpt" />
        </g> : <>
          <path d={claudePath} className="timelineAreaClaude" />
          <path d={chatgptPath} className="timelineAreaChatgpt" />
        </>}

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
