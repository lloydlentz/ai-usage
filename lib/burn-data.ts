// Column labels are deliberately tool-specific, not vendor-specific. "Codex CLI"
// and "ChatGPT app" are both OpenAI, but one is an exact log read and the other
// is an estimate — labelling both "ChatGPT" made the exact column look like it
// counted chat usage.
export const sourceColumns = [
  { key: "codex_tokens", label: "Codex CLI", fidelity: "exact" },
  { key: "claude_code_tokens", label: "Claude Code", fidelity: "exact" },
  { key: "claude_chat_est", label: "Claude chat", fidelity: "estimated" },
  { key: "chatgpt_est", label: "ChatGPT app", fidelity: "estimated" },
  { key: "gemini_est", label: "Gemini", fidelity: "estimated" },
] as const;

export type SourceKey = (typeof sourceColumns)[number]["key"];

// The five priced token types, in lifecycle order: what went in, what was
// cached, what came back. The bars in the UI read left to right in this order.
export const tokenTypes = [
  "input",
  "cache_write_5m",
  "cache_write_1h",
  "cache_read",
  "output",
] as const;

export type TokenType = (typeof tokenTypes)[number];

export const tokenTypeLabels: Record<TokenType, string> = {
  input: "Input",
  cache_write_5m: "Cache write 5m",
  cache_write_1h: "Cache write 1h",
  cache_read: "Cache read",
  output: "Output",
};

export type ByType = Record<TokenType, number>;

export const toolKeys = ["claude_code", "codex"] as const;
export type ToolKey = (typeof toolKeys)[number];

export const toolLabels: Record<ToolKey, string> = {
  claude_code: "Claude Code",
  codex: "Codex CLI",
};

// --- Raw JSON shapes -------------------------------------------------------
//
// Every field below is optional on purpose. A row written before the token-type
// split existed carries none of them, and a Codex model entry never carries the
// cache-write keys because OpenAI does not bill a cache-write premium. Absence
// is a distinct state from zero everywhere in this file.

type RawModelUsage = {
  calls?: number;
  input?: number;
  cache_write_5m?: number;
  cache_write_1h?: number;
  cache_read?: number;
  output?: number;
  tokens?: number;
  cost_usd?: number | null;
};

type RawToolBreakdown = {
  // The value is optional because TypeScript widens the imported JSON into a
  // union of per-day literal shapes, where a model absent on one day appears as
  // `undefined` on another. Treated the same way as any other missing key.
  models?: Record<string, RawModelUsage | undefined>;
  unattributed?: number;
};

type RawCost = {
  basis?: string;
  total?: number | null;
  by_tool?: Partial<Record<ToolKey, number | null>>;
  by_type?: Partial<Record<TokenType, number | null>>;
  unpriced_tokens?: number;
};

export type RawBurnRow = {
  date: string;
  codex_tokens?: number;
  claude_code_tokens?: number;
  claude_code_calls?: number;
  claude_chat_est?: number;
  chatgpt_est?: number;
  gemini_est?: number;
  total?: number;
  driver: string;
  evidence?: string;
  breakdown?: Partial<Record<ToolKey, RawToolBreakdown>>;
  cost_usd?: RawCost;
};

// --- Normalized shapes -----------------------------------------------------

export type ModelUsage = {
  model: string;
  calls: number | null;
  tokens: number;
  byType: ByType;
  /** null means the model has no rate card entry. Never coerce this to 0. */
  costUsd: number | null;
};

export type ToolBreakdown = {
  tool: ToolKey;
  models: ModelUsage[];
  /** Real tokens with no known model or type split. Priced as unknown. */
  unattributed: number;
};

/**
 * What the ledger knows about a day's cost. Modelled as a union rather than a
 * number so the three absence cases cannot collapse into "$0.00":
 *
 *   not-measured  no breakdown and no cost block. An estimates-only day: there
 *                 was no metered usage to price, so there is nothing to cost —
 *                 which is not the same as costing nothing.
 *   unknown       a cost block exists but every token in it is unpriced (an
 *                 external import, or a model with no rate card). The dollar
 *                 figure is not known at all.
 *   lower-bound   part of the day priced, part did not. `usd` is a floor.
 *   priced        every token had a rate. `usd` is complete.
 */
export type CostKnowledge =
  | { kind: "not-measured" }
  | { kind: "unknown"; unpricedTokens: number }
  | {
      kind: "lower-bound";
      usd: number;
      unpricedTokens: number;
      byTool: Partial<Record<ToolKey, number>>;
      byType: ByType;
    }
  | {
      kind: "priced";
      usd: number;
      byTool: Partial<Record<ToolKey, number>>;
      byType: ByType;
    };

/** The dollars a CostKnowledge is willing to assert. Unknown asserts nothing. */
export function costFloor(cost: CostKnowledge): number | null {
  return cost.kind === "priced" || cost.kind === "lower-bound" ? cost.usd : null;
}

export function costUnpriced(cost: CostKnowledge): number {
  return cost.kind === "unknown" || cost.kind === "lower-bound" ? cost.unpricedTokens : 0;
}

export type BurnRow = Required<Pick<RawBurnRow, SourceKey>> &
  Omit<RawBurnRow, SourceKey | "total" | "breakdown" | "cost_usd"> & {
    claude_code_calls: number;
    total: number;
    /** null means no per-type split was ever recorded for this day. */
    breakdown: ToolBreakdown[] | null;
    cost: CostKnowledge;
  };

export function emptyByType(): ByType {
  return { input: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, output: 0 };
}

export function normalizeRows(rows: RawBurnRow[]): BurnRow[] {
  return rows
    .map((row) => {
      const codex = asNumber(row.codex_tokens);
      const claudeCode = asNumber(row.claude_code_tokens);
      const claudeChat = asNumber(row.claude_chat_est);
      const chatgpt = asNumber(row.chatgpt_est);
      const gemini = asNumber(row.gemini_est);
      const computedTotal = codex + claudeCode + claudeChat + chatgpt + gemini;

      return {
        date: row.date,
        codex_tokens: codex,
        claude_code_tokens: claudeCode,
        claude_code_calls: asNumber(row.claude_code_calls),
        claude_chat_est: claudeChat,
        chatgpt_est: chatgpt,
        gemini_est: gemini,
        total: asNumber(row.total) || computedTotal,
        driver: row.driver || "unlabeled",
        evidence: row.evidence || "",
        breakdown: normalizeBreakdown(row.breakdown),
        cost: normalizeCost(row.cost_usd),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function normalizeBreakdown(
  raw: RawBurnRow["breakdown"],
): ToolBreakdown[] | null {
  if (!raw || typeof raw !== "object") return null;

  const tools: ToolBreakdown[] = [];
  for (const tool of toolKeys) {
    const entry = raw[tool];
    if (!entry) continue;
    const models = Object.entries(entry.models || {})
      .filter((pair): pair is [string, RawModelUsage] => Boolean(pair[1]))
      .map(([model, usage]) => normalizeModel(model, usage));
    tools.push({
      tool,
      models,
      unattributed: asNumber(entry.unattributed),
    });
  }

  return tools.length > 0 ? tools : null;
}

function normalizeModel(model: string, usage: RawModelUsage): ModelUsage {
  const byType = emptyByType();
  for (const type of tokenTypes) {
    // Read with a default: a Codex model has no cache-write keys at all, and
    // indexing them would produce undefined rather than 0.
    byType[type] = asNumber(usage[type]);
  }
  const summed = tokenTypes.reduce((sum, type) => sum + byType[type], 0);

  return {
    model,
    calls: Number.isFinite(usage.calls) ? Number(usage.calls) : null,
    tokens: asNumber(usage.tokens) || summed,
    byType,
    // A missing or null cost means "no rate card", which the UI must show as
    // unknown. Only a real number counts as priced.
    costUsd: typeof usage.cost_usd === "number" && Number.isFinite(usage.cost_usd)
      ? usage.cost_usd
      : null,
  };
}

function normalizeCost(raw: RawCost | undefined): CostKnowledge {
  if (!raw || typeof raw !== "object") return { kind: "not-measured" };

  const unpriced = asNumber(raw.unpriced_tokens);
  const total = typeof raw.total === "number" && Number.isFinite(raw.total) ? raw.total : null;

  // A cost block that priced nothing tells us the day had measured usage and
  // that we do not know what it cost. Reporting its 0.0 total would be a lie.
  if (total === null || (unpriced > 0 && total <= 0)) {
    return { kind: "unknown", unpricedTokens: unpriced };
  }

  const byType = emptyByType();
  for (const type of tokenTypes) {
    byType[type] = asNumber(raw.by_type?.[type] ?? undefined);
  }

  const byTool: Partial<Record<ToolKey, number>> = {};
  for (const tool of toolKeys) {
    const value = raw.by_tool?.[tool];
    if (typeof value === "number" && Number.isFinite(value)) byTool[tool] = value;
  }

  return unpriced > 0
    ? { kind: "lower-bound", usd: total, unpricedTokens: unpriced, byTool, byType }
    : { kind: "priced", usd: total, byTool, byType };
}

export function sumSource(rows: BurnRow[], key: SourceKey) {
  return rows.reduce((sum, row) => sum + row[key], 0);
}

/**
 * Roll a set of days up into one CostKnowledge. Days with nothing to cost are
 * skipped; days whose cost is unknown make the whole roll-up a lower bound, so
 * an unpriced day can never quietly disappear into a confident total.
 */
export function sumCost(rows: BurnRow[]): CostKnowledge {
  let usd = 0;
  let unpriced = 0;
  let measured = false;
  const byTool: Partial<Record<ToolKey, number>> = {};
  const byType = emptyByType();

  for (const row of rows) {
    const cost = row.cost;
    if (cost.kind === "not-measured") continue;
    measured = true;
    unpriced += costUnpriced(cost);
    if (cost.kind === "unknown") continue;

    usd += cost.usd;
    for (const tool of toolKeys) {
      const value = cost.byTool[tool];
      if (value !== undefined) byTool[tool] = (byTool[tool] || 0) + value;
    }
    for (const type of tokenTypes) byType[type] += cost.byType[type];
  }

  if (!measured) return { kind: "not-measured" };
  if (usd <= 0 && unpriced > 0) return { kind: "unknown", unpricedTokens: unpriced };
  return unpriced > 0
    ? { kind: "lower-bound", usd, unpricedTokens: unpriced, byTool, byType }
    : { kind: "priced", usd, byTool, byType };
}

/** Token counts per type across a set of days, plus the tokens with no split. */
export function sumTokensByType(rows: BurnRow[]) {
  const byType = emptyByType();
  let unattributed = 0;
  let measuredDays = 0;

  for (const row of rows) {
    if (!row.breakdown) continue;
    measuredDays += 1;
    for (const tool of row.breakdown) {
      unattributed += tool.unattributed;
      for (const model of tool.models) {
        for (const type of tokenTypes) byType[type] += model.byType[type];
      }
    }
  }

  const typed = tokenTypes.reduce((sum, type) => sum + byType[type], 0);
  return { byType, typed, unattributed, measuredDays };
}

export type ModelTotal = {
  model: string;
  tool: ToolKey;
  tokens: number;
  /** null when the model has no rate card on any day it appears. */
  costUsd: number | null;
};

/** Per-model totals, sorted by cost then tokens. Unpriced models sort last. */
export function sumByModel(rows: BurnRow[]): ModelTotal[] {
  const totals = new Map<string, ModelTotal>();

  for (const row of rows) {
    if (!row.breakdown) continue;
    for (const tool of row.breakdown) {
      for (const model of tool.models) {
        const key = `${tool.tool}::${model.model}`;
        const existing =
          totals.get(key) || { model: model.model, tool: tool.tool, tokens: 0, costUsd: null };
        existing.tokens += model.tokens;
        if (model.costUsd !== null) {
          existing.costUsd = (existing.costUsd || 0) + model.costUsd;
        }
        totals.set(key, existing);
      }
    }
  }

  // A model that logged no tokens at all (Claude Code's "<synthetic>" entries,
  // for instance) has nothing to report and only adds a zero row.
  return Array.from(totals.values())
    .filter((model) => model.tokens > 0)
    .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.tokens - a.tokens);
}

function asNumber(value: number | undefined) {
  return Number.isFinite(value) ? Number(value) : 0;
}
