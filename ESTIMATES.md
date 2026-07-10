# Estimate assumptions

Exact and estimated columns are never mixed. Exact columns come from local
logs; estimated columns come from a user interview on 2026-06-12 and the
deterministic weekday patterns below. If your habits change, update the
patterns in `scripts/build_daily_burn.py` and this file together.

## Exact sources

| Column | Source | Method |
| --- | --- | --- |
| `claude_code_tokens` | `~/.claude/projects/**/*.jsonl` | Sum of input + cache-creation + cache-read + output tokens per assistant API call, deduplicated by message/request id, bucketed by America/Chicago day. |
| `claude_code_calls` | same | Count of deduplicated assistant API calls. |
| `codex_tokens` | `~/.codex/sessions/**/*.jsonl` | Final cumulative `total_token_usage.total_tokens` per session, bucketed to the day of the session's last token event. |

## Estimated sources (labeled "estimated" in the UI)

Estimates are conservative weekday patterns, not measurements. The interview
answers and the math:

| Column | Interview answer | Pattern | Weekly total |
| --- | --- | --- | --- |
| `claude_chat_est` | "Most days" | 30,000 tokens Mon–Fri (~4 conversations × ~7.5k tokens) | 150k |
| `chatgpt_est` | "A few times a week" | 15,000 tokens Mon/Wed/Fri (~2 conversations × ~7.5k) | 45k |
| `gemini_est` | Antigravity IDE sometimes + gemini.google.com web chat | 50,000 tokens Tue/Thu (agentic IDE sessions burn more) + 8,000 tokens Mon/Fri (web chat) | 116k |

A "conversation" is assumed to cost ~7.5k tokens total because chat UIs
resend conversation context with each turn. Agentic IDE use (Antigravity) is
assumed to burn roughly what a light Codex day shows in the exact logs
(~50k–500k); 50k/day is the conservative low end.

Estimates apply across the whole dashboard range (May 4 onward), per the
interview. Days with neither exact usage nor an estimate pattern (weekends
with no coding) are omitted.

## Day definition

A "day" is midnight-to-midnight **America/Chicago**. UTC timestamps in the
raw logs are converted before bucketing.
