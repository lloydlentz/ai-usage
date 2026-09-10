"use client";

import { useState } from "react";
import type { BurnRow } from "../../lib/burn-data";
import { modelTokenShares, UNATTRIBUTED_MODEL } from "../../lib/model-share";
import { formatTokens, formatPct } from "../../lib/token-math";

const colors = ["#f0653b", "#7a4fc2", "#278d83", "#bd7920", "#c64b83", "#397ac0", "#748934", "#ae5c43", "#5d67ac", "#39865f", "#b475a2", "#667e91"];

export function ModelShare({ rows, modelNames }: { rows: BurnRow[]; modelNames: string[] }) {
  const { total, segments } = modelTokenShares(rows);
  const [active, setActive] = useState<string | null>(null);
  const label = (model: string) => model === UNATTRIBUTED_MODEL ? "Unattributed" : model;
  const color = (model: string) => model === UNATTRIBUTED_MODEL ? "#96938b" : colors[Math.max(0, modelNames.indexOf(model)) % colors.length];
  const summary = (segment: (typeof segments)[number]) => `${label(segment.model)}: ${formatPct(segment.percent)} · ${formatTokens(segment.tokens)} tokens`;

  return <section className="modelShare" aria-labelledby="model-share-title">
    <div className="modelShareHeading">
      <h3 id="model-share-title">Tokens by model</h3>
      <span>{formatTokens(total)} measured tokens in this period</span>
    </div>
    {total > 0 ? <>
      <div className="modelShareBar" role="img" aria-label={`Model shares of measured tokens. ${segments.map(summary).join(". ")}`}>
        {segments.map((segment) => <div key={segment.model}
          className="modelShareSegment"
          style={{ width: `${segment.percent}%`, backgroundColor: color(segment.model), opacity: active && active !== segment.model ? .3 : 1 }}
          onMouseEnter={() => setActive(segment.model)} onMouseLeave={() => setActive(null)}
          title={summary(segment)}
        >{segment.percent >= 8 && <span>{formatPct(segment.percent)}</span>}</div>)}
      </div>
      <ul className="modelShareLegend">
        {segments.map((segment) => <li key={segment.model}>
          <button type="button" aria-pressed={active === segment.model}
            onMouseEnter={() => setActive(segment.model)} onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(segment.model)} onBlur={() => setActive(null)}
            onClick={() => setActive((current) => current === segment.model ? null : segment.model)}
            title={`${formatTokens(segment.tokens)} tokens`}>
            <i style={{ backgroundColor: color(segment.model) }} aria-hidden="true" />
            <span>{label(segment.model)}</span> <strong>{formatPct(segment.percent)}</strong>
          </button>
        </li>)}
      </ul>
      <p className="modelShareNote">Includes input, cache and output tokens from Claude Code and Codex. Chat estimates are excluded; measurements without a model split are unattributed.</p>
    </> : <p className="modelShareNote">No measured tokens in this period.</p>}
  </section>;
}
