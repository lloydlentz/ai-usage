import type { BurnRow } from "./burn-data";

export const UNATTRIBUTED_MODEL = "<unattributed>";

/** Shares of measured tokens, including measurements without a model split. */
export function modelTokenShares(rows: BurnRow[]) {
  const counts = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    const measured = row.claude_code_tokens + row.codex_tokens;
    total += measured;
    let named = 0;
    for (const tool of row.breakdown || []) {
      for (const usage of tool.models) {
        if (usage.model.startsWith("<") || usage.tokens <= 0) continue;
        counts.set(usage.model, (counts.get(usage.model) || 0) + usage.tokens);
        named += usage.tokens;
      }
    }
    const unknown = Math.max(0, measured - named);
    if (unknown) counts.set(UNATTRIBUTED_MODEL, (counts.get(UNATTRIBUTED_MODEL) || 0) + unknown);
  }
  const segments = [...counts].map(([model, tokens]) => ({ model, tokens, percent: total ? tokens / total * 100 : 0 }))
    .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
  return { total, segments };
}
