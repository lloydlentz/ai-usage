import rawRows from "../data/daily-burn.json";
import rawThreads from "../data/threads.json";
import meta from "../data/meta.json";
import pricing from "../data/pricing.json";
import { normalizeRows, type RawBurnRow } from "./burn-data";
import { normalizeThreads, type RawThread } from "./threads";

export const PUBLIC_REPORT_URL = "https://firestore.googleapis.com/v1/projects/ai-usage-ledger-lentz/databases/(default)/documents/public_reports/ai_usage";
export const fallbackDashboard = { rows: normalizeRows(rawRows), threads: normalizeThreads(rawThreads), meta, pricing };
export type DashboardData = typeof fallbackDashboard;

export function parseDashboard(value: unknown): DashboardData {
  const report = value as { schema?: number; rows?: RawBurnRow[]; threads?: RawThread[]; meta?: typeof meta; pricing?: typeof pricing } | null;
  if (!report || report.schema !== 1 || !Array.isArray(report.rows) || !report.rows.length ||
      !Array.isArray(report.threads) || !report.meta?.sources_available ||
      !Number.isFinite(Date.parse(report.meta.refreshed_at)) ||
      !report.pricing?.models || typeof report.pricing.verified_at !== "string" ||
      typeof report.pricing.benchmark !== "string") throw new Error("Invalid dashboard snapshot");
  for (const row of report.rows) {
    if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || typeof row.driver !== "string" ||
        ![row.codex_tokens, row.claude_code_tokens, row.total].every((n) => Number.isSafeInteger(n) && Number(n) >= 0)) {
      throw new Error("Invalid dashboard day");
    }
  }
  return { rows: normalizeRows(report.rows), threads: normalizeThreads(report.threads), meta: report.meta, pricing: report.pricing };
}

/** Fetch one complete immutable generation; never mix rows and threads. */
export async function loadDashboard(previousVersion?: string, signal?: AbortSignal, request: typeof fetch = fetch): Promise<{ version: string; data: DashboardData } | null> {
  const get = async (url: string) => {
    const response = await request(url, { signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Dashboard request failed (${response.status})`);
    return response.json();
  };
  const manifest = (await get(PUBLIC_REPORT_URL)).fields;
  const version = manifest?.version?.stringValue;
  const count = Number(manifest?.chunks?.integerValue);
  if (Number(manifest?.schema?.integerValue) !== 1 || !/^[a-f0-9]{64}$/.test(version || "") ||
      !Number.isInteger(count) || count < 1 || count > 128) throw new Error("Invalid dashboard manifest");
  if (version === previousVersion) return null;
  const chunks = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const document = await get(`${PUBLIC_REPORT_URL}/versions/${version}/chunks/${index}`);
    const payload = document.fields?.payload?.stringValue;
    if (typeof payload !== "string") throw new Error("Incomplete dashboard snapshot");
    return payload;
  }));
  const payload = chunks.join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const actual = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
  if (actual !== version) throw new Error("Dashboard snapshot checksum mismatch");
  return { version, data: parseDashboard(JSON.parse(payload)) };
}
