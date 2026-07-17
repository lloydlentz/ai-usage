export const sourceColumns = [
  { key: "codex_tokens", label: "ChatGPT", fidelity: "exact" },
  { key: "claude_code_tokens", label: "Claude", fidelity: "exact" },
  { key: "claude_chat_est", label: "Claude chat", fidelity: "estimated" },
  { key: "chatgpt_est", label: "ChatGPT", fidelity: "estimated" },
  { key: "gemini_est", label: "Gemini", fidelity: "estimated" },
] as const;

export type SourceKey = (typeof sourceColumns)[number]["key"];

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
};

export type BurnRow = Required<Pick<RawBurnRow, SourceKey>> &
  Omit<RawBurnRow, SourceKey | "total"> & {
    claude_code_calls: number;
    total: number;
  };

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
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function sumSource(rows: BurnRow[], key: SourceKey) {
  return rows.reduce((sum, row) => sum + row[key], 0);
}

function asNumber(value: number | undefined) {
  return Number.isFinite(value) ? Number(value) : 0;
}
