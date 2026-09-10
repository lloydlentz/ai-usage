"use client";

import { useEffect, useMemo, useState } from "react";
import { type BurnRow, type ToolKey, toolLabels, tokenTypes, tokenTypeLabels, subtotalCost, sumByModel } from "../../lib/burn-data";
import { formatTokens } from "../../lib/token-math";
import { driverCategories, parseDriverLabels, type DriverLabels, type DriverCategory } from "../../lib/driver-labels";
import { BasisPill, CellCost } from "./cost";

const STORAGE_KEY = "token-burn-driver-labels-v1";

export function UsageExplorer({ rows }: { rows: BurnRow[] }) {
  const [tool, setTool] = useState<ToolKey | "all">("all");
  const [model, setModel] = useState("all");
  const [onlyUnlabeled, setOnlyUnlabeled] = useState(false);
  const [labels, setLabels] = useState<DriverLabels>({});
  const [storageError, setStorageError] = useState("");
  useEffect(() => {
    try {
      // Stored preferences are applied after hydration, never during SSR.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLabels(parseDriverLabels(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")));
    } catch { setStorageError("Browser storage is unavailable. Export your labels to keep them."); }
  }, []);

  const models = useMemo(() => [...new Set(rows.flatMap((row) => row.breakdown?.filter((entry) => tool === "all" || entry.tool === tool).flatMap((entry) => entry.models.map((usage) => usage.model)) || []))].sort(), [rows, tool]);
  const visible = [...rows].reverse().filter((row) => {
    if (onlyUnlabeled && (labels[row.date] || row.driver) !== "unlabeled") return false;
    if (tool === "all" && model === "all") return true;
    return row.breakdown?.some((entry) => (tool === "all" || entry.tool === tool) && (model === "all" || entry.models.some((usage) => usage.model === model)));
  });
  const unlabeled = rows.filter((row) => (labels[row.date] || row.driver) === "unlabeled");
  const volume = rows.reduce((sum, row) => sum + row.total, 0);
  const unlabeledVolume = unlabeled.reduce((sum, row) => sum + row.total, 0);

  function saveLabel(day: string, category: DriverCategory) {
    const next = { ...labels, [day]: category };
    setLabels(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); }
    catch { setStorageError("Browser storage is unavailable. Export your labels to keep them."); }
  }
  function exportLabels() {
    const blob = new Blob([JSON.stringify({ version: 1, labels: parseDriverLabels(labels) }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = "driver-labels.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <section className="panel usageExplorer" aria-labelledby="explorer-title">
    <div className="panelHeader"><div><p className="label">Investigate a day</p><h2 id="explorer-title">Explore recorded usage</h2></div>
      <p>{unlabeled.length} unlabeled days · {volume ? (100 * unlabeledVolume / volume).toFixed(1) : "0"}% of volume in this date range</p></div>
    <div className="dashboardControls">
      <label>Tool<select value={tool} onChange={(e) => { setTool(e.target.value as ToolKey | "all"); setModel("all"); }}><option value="all">All tools</option>{Object.entries(toolLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>Model<select value={model} onChange={(e) => setModel(e.target.value)}><option value="all">All models</option>{models.map((name) => <option key={name}>{name}</option>)}</select></label>
      <label className="checkboxLabel"><input type="checkbox" checked={onlyUnlabeled} onChange={(e) => setOnlyUnlabeled(e.target.checked)} />Unlabeled only</label>
      <button type="button" onClick={exportLabels} disabled={!Object.keys(labels).length}>Export labels</button>
    </div>
    <p className="muted">Tool and model filters apply to this explorer. Expand a date for its measured breakdown. Labels are saved in this browser; export them to update the dashboard source. Only dates and preset categories are exported.</p>
    {storageError && <p role="status">{storageError}</p>}
    <p role="status">{visible.length} matching days</p>
    <div className="explorerDays">
      {visible.map((row) => {
        const totals = sumByModel([row]).filter((usage) => (tool === "all" || usage.tool === tool) && (model === "all" || usage.model === model));
        return <details key={row.date} className="explorerDay">
          <summary>{row.date} · {formatTokens(row.codex_tokens + row.claude_code_tokens)} measured tokens · {labels[row.date] || row.driver}</summary>
          <label>Category for {row.date}<select aria-label={`Category for ${row.date}`} value={labels[row.date] || row.driver} onChange={(e) => saveLabel(row.date, e.target.value as DriverCategory)}>{driverCategories.map((category) => <option key={category}>{category}</option>)}</select></label>
          <p>Whole-day cost: <CellCost cost={row.cost} /> <BasisPill /></p>
          <div className="tableWrap"><table className="table"><caption>Measured models matching the explorer filters</caption><thead><tr><th>Tool / model</th>{tokenTypes.map((type) => <th key={type}>{tokenTypeLabels[type]}</th>)}<th>Cost <span className="thBasis">at API list</span></th></tr></thead><tbody>
            {totals.map((usage) => {
              const split = row.breakdown?.find((entry) => entry.tool === usage.tool)?.models.find((entry) => entry.model === usage.model);
              return <tr key={`${usage.tool}:${usage.model}`}><th>{toolLabels[usage.tool]} / {usage.model}</th>{tokenTypes.map((type) => <td key={type}>{formatTokens(split?.byType[type] || 0)}</td>)}<td><CellCost cost={subtotalCost(usage.costUsd, usage.unpricedTokens)} /></td></tr>;
            })}
          </tbody></table></div>
          {(!row.breakdown || row.breakdown.some((entry) => entry.unattributed > 0)) && <p>Some measured tokens have no model/type attribution. They remain in the daily total with unknown cost.</p>}
          {row.claude_chat_est + row.chatgpt_est + row.gemini_est > 0 && <p>{formatTokens(row.claude_chat_est + row.chatgpt_est + row.gemini_est)} additional tokens are weekday chat estimates, not measurements.</p>}
        </details>;
      })}
    </div>
  </section>;
}
