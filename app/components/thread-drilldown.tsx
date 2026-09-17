"use client";

import { useState } from "react";
import { toolLabels, type ToolKey } from "../../lib/burn-data";
import type { DateRange } from "../../lib/date-windows";
import { summarizeThreads, type Thread, type ThreadSort } from "../../lib/threads";
import { formatPct, formatTokens } from "../../lib/token-math";
import { BasisPill, CellCost } from "./cost";

const TOP = 10;
// These threads remain in the published accounting data, but stay out of the
// default ranking so the dashboard can be shared without leading with personal
// work. Keys are stable across rebuilds even if a thread title later changes.
const HIDDEN_BY_DEFAULT = new Set([
  "cc-8c9f203dbed9", // Cohorts.ART
  "cc-867efb14c0d0", // Set up Apple developer account
]);
// The tool summary's colors: --accent is Claude Code, --good is Codex.
const toolColor: Record<ToolKey, string> = { claude_code: "var(--accent)", codex: "var(--good)" };

/**
 * Conversation threads ranked within the selected dates. It follows the same
 * range as every panel below the timeline, and counts only each thread's days
 * inside it. Measured tokens that no captured thread accounts for are shown as
 * their own row, so the table always adds up to the period's measured total.
 */
export function ThreadDrilldown({ threads, range, measured }: {
  threads: Thread[];
  range: DateRange;
  measured: Record<ToolKey, number>;
}) {
  const [tool, setTool] = useState<ToolKey | "all">("all");
  const [sort, setSort] = useState<ThreadSort>("tokens");
  const [showAll, setShowAll] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  const summaries = summarizeThreads(threads, range, { tool, sort });
  const hidden = summaries.filter((thread) => HIDDEN_BY_DEFAULT.has(thread.key));
  const ranked = showHidden ? summaries : summaries.filter((thread) => !HIDDEN_BY_DEFAULT.has(thread.key));
  const periodTotal = tool === "all" ? measured.claude_code + measured.codex : measured[tool];
  const attributed = summaries.reduce((sum, thread) => sum + thread.tokens, 0);
  const remainder = Math.max(0, periodTotal - attributed);
  const peak = ranked.reduce((max, thread) => Math.max(max, thread.tokens), 0);
  const visible = showAll ? ranked : ranked.slice(0, TOP);
  const share = (tokens: number) => (periodTotal ? (tokens / periodTotal) * 100 : 0);
  const hiddenLabel = `${hidden.length} hidden ${hidden.length === 1 ? "thread" : "threads"}`;

  return <section className="panel threadDrilldown" aria-labelledby="threads-title">
    <div className="panelHeader">
      <div><p className="label">Drill down</p><h2 id="threads-title" aria-label="Which threads burned it">
        <button
          type="button"
          className="threadDisclosure"
          aria-expanded={showHidden}
          aria-label={showHidden ? `Hide ${hiddenLabel}` : `Show ${hiddenLabel}`}
          onClick={() => { setShowHidden((shown) => !shown); setShowAll(false); }}
        >
          <span>Which threads burned it</span>
          <span className="threadHiddenCount" aria-hidden="true">{showHidden ? `${hidden.length} revealed` : `${hidden.length} hidden`}</span>
          <i aria-hidden="true" />
        </button>
      </h2></div>
      <p>{ranked.length} {ranked.length === 1 ? "thread" : "threads"} ranked · {formatTokens(attributed)} of {formatTokens(periodTotal)} measured tokens in this period</p>
    </div>
    <div className="dashboardControls">
      <label>Tool<select value={tool} onChange={(e) => { setTool(e.target.value as ToolKey | "all"); setShowAll(false); }}>
        <option value="all">All tools</option>
        {Object.entries(toolLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>Order<select value={sort} onChange={(e) => setSort(e.target.value as ThreadSort)}>
        <option value="tokens">Most tokens</option>
        <option value="recent">Most recent</option>
      </select></label>
    </div>
    {ranked.length > 0 ? <div className="tableWrap"><table className="table threadTable">
      <caption className="srOnly">Threads ranked by {sort === "tokens" ? "measured tokens" : "latest activity"} in the selected dates</caption>
      <thead><tr>
        <th scope="col">#</th>
        <th scope="col">Thread</th>
        <th scope="col">Tokens</th>
        <th scope="col">Share</th>
        <th scope="col">Cost <span className="thBasis">at API list</span></th>
        <th scope="col">Active</th>
      </tr></thead>
      <tbody>
        {visible.map((thread, index) => <tr key={thread.key}>
          <td className="threadRank">{index + 1}</td>
          <th scope="row" className="threadName">
            <span className="threadTool">
              <i style={{ backgroundColor: toolColor[thread.tool] }} aria-hidden="true" />
              <span>{toolLabels[thread.tool]}</span>
              {thread.model && <span className="threadModel">· {thread.model}</span>}
            </span>
            <span className="threadTitle">{thread.title || "Untitled thread"}</span>
          </th>
          <td className="threadTokens">
            <strong>{formatTokens(thread.tokens)}</strong>
            <span className="threadBar" aria-hidden="true"><i style={{ width: `${peak ? (thread.tokens / peak) * 100 : 0}%`, backgroundColor: toolColor[thread.tool] }} /></span>
          </td>
          <td>{formatPct(share(thread.tokens))}</td>
          <td><CellCost cost={thread.cost} /></td>
          <td className="threadActive">
            {thread.firstDay === thread.lastDay ? thread.lastDay : `${thread.firstDay} – ${thread.lastDay}`}
            {thread.activeDays > 1 && <span className="muted"> · {thread.activeDays} days</span>}
          </td>
        </tr>)}
      </tbody>
      {remainder > 0 && <tfoot><tr>
        <td />
        <th scope="row">Not attributed to a thread</th>
        <td>{formatTokens(remainder)}</td>
        <td>{formatPct(share(remainder))}</td>
        <td />
        <td />
      </tr></tfoot>}
    </table></div> : <p className="threadEmpty muted">No measured thread activity in these dates.</p>}
    {ranked.length > TOP && <button type="button" className="threadMore" aria-expanded={showAll} onClick={() => setShowAll((all) => !all)}>
      {showAll ? `Show top ${TOP}` : `Show all ${ranked.length} threads`}
    </button>}
    <p className="panelFoot">
      <BasisPill /> Each thread counts only its tokens inside the selected dates. Sub-agent work rolls into its parent thread.
      Measured tokens not attributed to a thread come from logs pruned before threads were captured.
    </p>
  </section>;
}
