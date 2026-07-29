"""Tests for scripts/extract_exact.py.

Everything runs against the synthetic JSONL tree in tests/fixtures/home,
never the real ~/.claude or ~/.codex logs.

Fixture ground truth (America/Chicago days):

  Claude Code
    project-a/session-1.jsonl
      - a non-assistant `user` line                       -> skipped
      - msg_001/req_001  2026-07-16T14:00Z  10+100+1000+5 -> 1115 on 07-16
      - an assistant line with no `usage`                 -> skipped
      - an assistant line with no `timestamp`             -> skipped
      - a truncated (unparseable) JSON line               -> skipped
      - a `system` line that does carry usage             -> skipped
      - msg_002/req_002  2026-07-17T04:30Z  20+30         -> 50 on 07-16 (23:30 CDT)
    project-a/session-2-fork.jsonl
      - msg_001/req_001 replayed by a forked session      -> deduped, 0
      - two lines with neither message.id nor requestId    -> 7 and 9 on 07-16
    project-b/session-3.jsonl
      - msg_003/req_003        1000+2000+3000+4000        -> 10000 on 07-18
      - msg_003/req_003_retry  200+300 (same id, new req) -> 500 on 07-18
    project-c/session-models.jsonl  (all 2026-07-23)
      - msg_100 claude-sonnet-5  in 10, cache_creation 300
                                 (5m 100 / 1h 200), read 5000, out 40 -> 5350
      - msg_101 claude-opus-5    in 5, cache_creation 80 with NO
                                 `cache_creation` sub-object, read 900,
                                 out 15                                -> 1000
      - msg_102 <synthetic>      all four fields zero                  ->    0
      - msg_103 no `model` key   in 7, out 3                           ->   10

    => 07-16: 1181 tokens / 4 calls
       07-18: 10500 tokens / 2 calls
       07-23:  6360 tokens / 4 calls

  Codex
    sessions/.../rollout-multiday.jsonl  cwd /Users/demo/project-a
      cumulative totals 1000, 3000 (07-16) then 8000, 8000 (07-17)
      => 07-16: 3000    07-17: 5000    (deltas, not the 8000 cumulative)
    sessions/.../rollout-stale-replay.jsonl  cwd /Users/demo/project-b
      cumulative totals 5000, 2000 (stale replay), 5200 all on 07-18
      => 07-18: 5200 -- the high-water mark ignores the dip, so the
         session scores its true final total, not 5000+2000+3200
    sessions/.../rollout-no-meta.jsonl   no session_meta line
      => 07-19: 400, and no day_projects entry
    archived_sessions/.../rollout-archived.jsonl  cwd /Users/demo/project-a
      => 07-20: 250
    sessions/.../rollout-external-import.jsonl  cwd /Users/demo/project-a
      one event, total 9000, every per-type field zero, no turn_context.
      Shaped exactly like the real 2026-06-08 Codex Desktop import.
      => 07-21: 9000 tokens, all of it `unattributed`, no model entry
    sessions/.../rollout-typed.jsonl  cwd /Users/demo/project-b
      turn_context gpt-5.6-terra, then cumulative
        in 1000 (600 cached) / out 400 (250 reasoning) / total 1400
      then a stale replay (in 400 / out 100 / total 500) -> contributes 0
      then turn_context gpt-5.6-sol, cumulative
        in 1500 (900 cached) / out 700 (400 reasoning) / total 2200
      => 07-22: 2200, split terra 1400 / sol 800
"""

import json
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

from ._loader import FIXTURE_HOME, load_script

extract_exact = load_script("extract_exact")

PROJECT_A = "-Users-demo-project-a"
PROJECT_B = "-Users-demo-project-b"
PROJECT_C = "-Users-demo-project-c"


class FixtureHomeTestCase(unittest.TestCase):
    """Point the script's module-level HOME at the fixture tree."""

    def setUp(self):
        self._real_home = extract_exact.HOME
        extract_exact.HOME = FIXTURE_HOME

    def tearDown(self):
        extract_exact.HOME = self._real_home


class LocalDateTests(unittest.TestCase):
    """local_date() must bucket on the Chicago day, not the UTC day."""

    def test_same_day_in_both_zones(self):
        self.assertEqual(extract_exact.local_date("2026-07-16T14:00:00Z"), "2026-07-16")

    def test_late_evening_utc_belongs_to_previous_chicago_day(self):
        # 04:30 UTC on the 17th is 23:30 CDT on the 16th.
        self.assertEqual(extract_exact.local_date("2026-07-17T04:30:00Z"), "2026-07-16")

    def test_winter_offset_is_six_hours(self):
        # 05:30 UTC in January is 23:30 CST the day before.
        self.assertEqual(extract_exact.local_date("2026-01-05T05:30:00Z"), "2026-01-04")

    def test_spring_forward_boundary(self):
        # DST starts 2026-03-08 at 02:00 local (08:00 UTC).
        # Just before: still CST (UTC-6), so this is the 7th in Chicago.
        self.assertEqual(extract_exact.local_date("2026-03-08T05:30:00Z"), "2026-03-07")
        # Just after: CDT (UTC-5), 03:30 on the 8th.
        self.assertEqual(extract_exact.local_date("2026-03-08T08:30:00Z"), "2026-03-08")

    def test_fall_back_boundary(self):
        # DST ends 2026-11-01 at 02:00 local (07:00 UTC).
        # Before the switch Chicago is still CDT (UTC-5) -> 23:30 on Oct 31.
        self.assertEqual(extract_exact.local_date("2026-11-01T04:30:00Z"), "2026-10-31")
        # After the switch Chicago is CST (UTC-6) -> 01:30 on Nov 1.
        self.assertEqual(extract_exact.local_date("2026-11-01T07:30:00Z"), "2026-11-01")

    def test_accepts_offset_and_naive_timestamps(self):
        # Explicit offset is honoured...
        self.assertEqual(
            extract_exact.local_date("2026-07-16T23:30:00-05:00"), "2026-07-16"
        )
        # ...and a naive timestamp is assumed to be UTC.
        self.assertEqual(extract_exact.local_date("2026-07-17T04:30:00"), "2026-07-16")


class ExtractClaudeCodeTests(FixtureHomeTestCase):
    def setUp(self):
        super().setUp()
        (
            self.tokens,
            self.calls,
            self.projects,
            self.models,
        ) = extract_exact.extract_claude_code()

    def test_daily_totals_sum_all_four_usage_fields(self):
        # 1115 (10+100+1000+5) + 50 (20+30, no cache keys) + 7 + 9
        self.assertEqual(
            dict(self.tokens),
            {"2026-07-16": 1181, "2026-07-18": 10500, "2026-07-23": 6360},
        )

    def test_missing_cache_fields_default_to_zero(self):
        # msg_002 has only input/output tokens; if the .get() defaults
        # regressed to None this would have raised during extraction.
        self.assertEqual(self.tokens["2026-07-16"], 1181)

    def test_call_counts_exclude_skipped_entries(self):
        # 07-16: msg_001, msg_002 and the two unkeyed lines = 4.
        # The user line, the usage-less line, the timestamp-less line,
        # the truncated line and the system line are all skipped.
        self.assertEqual(
            dict(self.calls),
            {"2026-07-16": 4, "2026-07-18": 2, "2026-07-23": 4},
        )

    def test_duplicate_request_across_transcripts_counted_once(self):
        # msg_001/req_001 appears in both session-1.jsonl and the fork.
        # Counting it twice would make 07-16 read 2296 / 5 calls.
        self.assertEqual(self.tokens["2026-07-16"], 1181)
        self.assertEqual(self.calls["2026-07-16"], 4)

    def test_entries_without_ids_are_never_deduped_against_each_other(self):
        # Two lines share the (None, None) key; the guard must let both
        # through, contributing 7 + 9. Dropping one would give 1172.
        self.assertEqual(self.tokens["2026-07-16"] - 1115 - 50, 16)

    def test_same_message_id_with_different_request_id_counts_twice(self):
        # A retried request shares message.id but gets a new requestId.
        self.assertEqual(self.tokens["2026-07-18"], 10500)
        self.assertEqual(self.calls["2026-07-18"], 2)

    def test_malformed_line_does_not_abort_the_file(self):
        # The truncated line sits before msg_002 in session-1.jsonl, so
        # msg_002's 50 tokens only land if the parse error was swallowed.
        self.assertIn("2026-07-16", self.tokens)
        self.assertGreater(self.tokens["2026-07-16"], 1115 + 16)

    def test_tokens_attributed_to_project_directory_name(self):
        self.assertEqual(dict(self.projects["2026-07-16"]), {PROJECT_A: 1181})
        self.assertEqual(dict(self.projects["2026-07-18"]), {PROJECT_B: 10500})
        self.assertEqual(dict(self.projects["2026-07-23"]), {PROJECT_C: 6360})

    def test_missing_projects_directory_yields_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            extract_exact.HOME = Path(tmp)
            tokens, calls, projects, models = extract_exact.extract_claude_code()
        self.assertEqual(dict(tokens), {})
        self.assertEqual(dict(calls), {})
        self.assertEqual(dict(projects), {})
        self.assertEqual(dict(models), {})

    # --- per-model, per-type split ---------------------------------------

    def test_tokens_are_split_by_model(self):
        self.assertEqual(
            sorted(self.models["2026-07-23"]),
            ["<synthetic>", "<unknown>", "claude-opus-5", "claude-sonnet-5"],
        )

    def test_each_of_the_four_types_lands_in_its_own_bucket(self):
        # The whole point of the change: these are billed at wildly
        # different rates, so collapsing them into one number (5350) throws
        # away everything needed to price the day.
        entry = self.models["2026-07-23"]["claude-sonnet-5"]
        self.assertEqual(entry["input"], 10)
        self.assertEqual(entry["cache_read"], 5_000)
        self.assertEqual(entry["output"], 40)

    def test_cache_writes_split_by_ephemeral_ttl(self):
        # A 1-hour write bills at 2x base input against 1.25x for a 5-minute
        # one, so the `cache_creation` sub-object is worth reading.
        entry = self.models["2026-07-23"]["claude-sonnet-5"]
        self.assertEqual(entry["cache_write_5m"], 100)
        self.assertEqual(entry["cache_write_1h"], 200)
        self.assertEqual(
            entry["cache_write_5m"] + entry["cache_write_1h"], 300
        )  # == cache_creation_input_tokens

    def test_missing_ttl_split_falls_back_to_the_cheaper_bucket(self):
        # msg_101 has cache_creation_input_tokens but no `cache_creation`
        # sub-object. Guessing 1h would over-claim cost; 5m under-claims,
        # which is the safe direction for a counterfactual.
        entry = self.models["2026-07-23"]["claude-opus-5"]
        self.assertEqual(entry["cache_write_5m"], 80)
        self.assertEqual(entry["cache_write_1h"], 0)

    def test_entry_without_a_model_is_labeled_unknown_not_dropped(self):
        entry = self.models["2026-07-23"]["<unknown>"]
        self.assertEqual(entry["input"], 7)
        self.assertEqual(entry["output"], 3)

    def test_synthetic_entries_are_kept_with_zero_tokens(self):
        # Claude Code's local placeholder turns are real calls that cost
        # nothing. Dropping them would silently lose a call from the count.
        entry = self.models["2026-07-23"]["<synthetic>"]
        self.assertEqual(entry["calls"], 1)
        self.assertEqual(
            sum(entry[t] for t in extract_exact.TOKEN_TYPES), 0
        )

    def test_per_model_calls_sum_to_the_day_call_count(self):
        for day, calls in self.calls.items():
            with self.subTest(day=day):
                self.assertEqual(
                    sum(m["calls"] for m in self.models[day].values()), calls
                )

    def test_per_model_types_sum_to_the_day_aggregate(self):
        # The aggregate column must stay exactly what it always was: the
        # sum of the four usage fields. If the split ever disagreed with it
        # the dashboard's headline and its breakdown would contradict.
        for day, total in self.tokens.items():
            with self.subTest(day=day):
                self.assertEqual(
                    sum(
                        counts[t]
                        for counts in self.models[day].values()
                        for t in extract_exact.TOKEN_TYPES
                    ),
                    total,
                )


class ExtractCodexTests(FixtureHomeTestCase):
    def setUp(self):
        super().setUp()
        (
            self.tokens,
            self.projects,
            self.models,
            self.unattributed,
        ) = extract_exact.extract_codex()

    def test_multiday_session_splits_deltas_across_chicago_days(self):
        # This is the subtlest rule in the file: the cumulative counter
        # reaches 8000, but only the 5000 earned after midnight belongs
        # to 07-17. Dumping the cumulative total on the last day would
        # give 07-16: 3000 / 07-17: 8000.
        self.assertEqual(self.tokens["2026-07-16"], 3000)
        self.assertEqual(self.tokens["2026-07-17"], 5000)

    def test_multiday_session_total_equals_final_cumulative(self):
        self.assertEqual(self.tokens["2026-07-16"] + self.tokens["2026-07-17"], 8000)

    def test_repeated_identical_total_adds_nothing(self):
        # The second 8000 event has a zero delta.
        self.assertEqual(self.tokens["2026-07-17"], 5000)

    def test_stale_low_total_cannot_inflate_the_day(self):
        # The whole point of the high-water mark. Totals go 5000 -> 2000
        # (a stale/duplicated line) -> 5200, and the true burn is 5200.
        #
        # The previous implementation read the dip as a context-window
        # reset and added the entire 2000, then 3200 more when the counter
        # climbed past it again: 5000 + 2000 + 3200 = 10200, nearly 2x --
        # and daily-burn.json freezes captured numbers, so that would be
        # permanent.
        #
        # Evidence that the dip is never a real reset, from a survey of
        # the author's 55 real rollout files / 2,137 token_count events:
        # the cumulative total decreased 0 times; events were already in
        # timestamp order (0 out-of-order); and compaction does not zero
        # the counter -- 27 of 54 sessions run past model_context_window
        # (258,400), the largest reaching 104,986,848, about 406x. Codex
        # accumulates for the life of a rollout and starts a new file for
        # a new session. So a decrease can only be a bad line, and the
        # high-water mark is the reading that cannot inflate.
        self.assertEqual(self.tokens["2026-07-18"], 5200)
        self.assertEqual(dict(self.projects["2026-07-18"]), {PROJECT_B: 5200})

    def test_high_water_mark_never_recounts_the_span_below_a_dip(self):
        # Stated as an invariant rather than an arithmetic coincidence:
        # a session's contribution equals its highest cumulative total,
        # no matter how the counter wobbled getting there.
        self.assertEqual(self.tokens["2026-07-18"], 5200)

    def test_session_without_meta_still_counts_tokens_but_has_no_project(self):
        self.assertEqual(self.tokens["2026-07-19"], 400)
        self.assertNotIn("2026-07-19", self.projects)

    def test_archived_sessions_directory_is_scanned(self):
        self.assertEqual(self.tokens["2026-07-20"], 250)
        self.assertEqual(dict(self.projects["2026-07-20"]), {PROJECT_A: 250})

    def test_project_key_derived_from_session_meta_cwd(self):
        # payload.cwd "/Users/demo/project-a" -> "-Users-demo-project-a",
        # matching how Claude Code names its project directories so both
        # tools roll up under one key.
        self.assertEqual(dict(self.projects["2026-07-16"]), {PROJECT_A: 3000})
        self.assertEqual(dict(self.projects["2026-07-17"]), {PROJECT_A: 5000})

    def test_non_token_count_and_malformed_payloads_are_skipped(self):
        # The response_item line, the truncated line and the token_count
        # with an empty `info` must not perturb any day.
        self.assertEqual(
            dict(self.tokens),
            {
                "2026-07-16": 3000,
                "2026-07-17": 5000,
                "2026-07-18": 5200,
                "2026-07-19": 400,
                "2026-07-20": 250,
                "2026-07-21": 9000,
                "2026-07-22": 2200,
            },
        )

    def test_missing_codex_directory_yields_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            extract_exact.HOME = Path(tmp)
            tokens, projects, models, unattributed = extract_exact.extract_codex()
        self.assertEqual(dict(tokens), {})
        self.assertEqual(dict(projects), {})
        self.assertEqual(dict(models), {})
        self.assertEqual(dict(unattributed), {})

    # --- nesting: cached is a SUBSET of input, reasoning of output -------

    def test_cached_input_is_subtracted_from_input_not_added_to_it(self):
        # `cached_input_tokens` is a subset of `input_tokens`, verified
        # across all 2,137 real events (0 violations). Treating the four
        # fields as additive would double-count every cache hit -- on this
        # dataset that is most of the volume.
        entry = self.models["2026-07-22"]["gpt-5.6-terra"]
        self.assertEqual(entry["cache_read"], 600)  # the cached subset
        self.assertEqual(entry["input"], 400)  # 1000 total - 600 cached
        self.assertEqual(entry["input"] + entry["cache_read"], 1000)

    def test_reasoning_tokens_are_folded_into_output_not_added(self):
        # `reasoning_output_tokens` (250) is a subset of `output_tokens`
        # (400) and bills at the output rate, so `output` carries the full
        # 400 and reasoning is never a sibling key. Adding it would report
        # 650 output tokens where 400 were spent.
        entry = self.models["2026-07-22"]["gpt-5.6-terra"]
        self.assertEqual(entry["output"], 400)

    def test_types_sum_to_the_total_delta(self):
        for day, total in self.tokens.items():
            with self.subTest(day=day):
                typed = sum(
                    counts.get(t, 0)
                    for counts in self.models[day].values()
                    for t in extract_exact.TOKEN_TYPES
                )
                self.assertEqual(typed + self.unattributed.get(day, 0), total)

    def test_codex_reports_no_cache_write_tokens(self):
        # `cache_write_input_tokens` exists on 244 real events and is 0 on
        # every one, so the key is absent rather than a misleading zero.
        for models in self.models.values():
            for counts in models.values():
                self.assertNotIn("cache_write_5m", counts)
                self.assertNotIn("cache_write_1h", counts)

    # --- per-type high-water mark ----------------------------------------

    def test_stale_replay_cannot_inflate_a_per_type_figure(self):
        # Same guard as the aggregate, applied per field. The stale event
        # reports in 400 / cached 100 / out 100 after marks of 1000/600/400.
        # If a per-type delta were computed naively against the previous
        # event, the climb back to 1500/900/700 would be counted twice.
        terra = self.models["2026-07-22"]["gpt-5.6-terra"]
        sol = self.models["2026-07-22"]["gpt-5.6-sol"]
        self.assertEqual(terra["tokens"] if "tokens" in terra else 1400, 1400)
        self.assertEqual(sol["input"], 200)  # 1500 - 1000, not 1500 - 400
        self.assertEqual(sol["cache_read"], 300)  # 900 - 600, not 900 - 100
        self.assertEqual(sol["output"], 300)  # 700 - 400, not 700 - 100

    def test_stale_replay_does_not_lower_the_per_type_baseline(self):
        # The session's per-type contribution equals its final cumulative
        # values, no matter how the counters wobbled getting there.
        totals = {"input": 0, "cache_read": 0, "output": 0}
        for counts in self.models["2026-07-22"].values():
            for field in totals:
                totals[field] += counts.get(field, 0)
        self.assertEqual(totals["cache_read"], 900)  # final cached_input_tokens
        self.assertEqual(totals["input"] + totals["cache_read"], 1500)  # final input
        self.assertEqual(totals["output"], 700)  # final output_tokens

    # --- model attribution ------------------------------------------------

    def test_model_comes_from_turn_context_and_can_change_mid_session(self):
        # session_meta has no model field; turn_context does, and a session
        # that switches models must attribute each event to the one in
        # force at the time rather than to the first or last seen.
        self.assertEqual(
            sorted(self.models["2026-07-22"]), ["gpt-5.6-sol", "gpt-5.6-terra"]
        )

    def test_session_with_no_turn_context_attributes_to_unknown(self):
        self.assertIn("<unknown>", self.models["2026-07-21"])

    # --- the 2026-06-08-shaped external import ---------------------------

    def test_import_event_tokens_are_real_and_counted(self):
        # 14 real events on 2026-06-08 look like this: a nonzero total with
        # every per-type field at zero, written by a bulk Codex Desktop
        # import (`turn_id: external-import-turn-N`). The tokens are real
        # and must not be dropped from the headline.
        self.assertEqual(self.tokens["2026-07-21"], 9000)

    def test_import_event_split_is_unattributed_not_zero(self):
        # Their composition is genuinely unknown. Recording zeros for each
        # type would claim we know the split and that it was free.
        self.assertEqual(self.unattributed["2026-07-21"], 9000)

    def test_import_event_contributes_no_typed_tokens(self):
        typed = sum(
            counts.get(t, 0)
            for counts in self.models["2026-07-21"].values()
            for t in extract_exact.TOKEN_TYPES
        )
        self.assertEqual(typed, 0)

    def test_normal_days_have_no_unattributed_tokens(self):
        self.assertNotIn("2026-07-22", self.unattributed)
        self.assertNotIn("2026-07-16", self.unattributed)


class ToolBreakdownTests(unittest.TestCase):
    """The rendered shape has to stay byte-stable across hourly cron runs."""

    def test_keys_are_written_in_canonical_order(self):
        out = extract_exact.tool_breakdown(
            {"m": {"output": 1, "input": 2}},
            extract_exact.CLAUDE_CODE_TYPES,
            with_calls=True,
        )
        self.assertEqual(
            list(out["models"]["m"]),
            ["calls", *extract_exact.TOKEN_TYPES, "tokens"],
        )

    def test_models_are_sorted(self):
        out = extract_exact.tool_breakdown(
            {"zeta": {"input": 1}, "alpha": {"input": 1}},
            extract_exact.CODEX_TYPES,
        )
        self.assertEqual(list(out["models"]), ["alpha", "zeta"])

    def test_zero_valued_types_are_written_not_omitted(self):
        # An omitted-when-zero key would make a model's key set wobble from
        # day to day, and the committed file is regenerated every hour.
        out = extract_exact.tool_breakdown({"m": {"input": 5}}, extract_exact.CODEX_TYPES)
        self.assertEqual(out["models"]["m"], {"input": 5, "cache_read": 0, "output": 0, "tokens": 5})

    def test_codex_entries_omit_the_cache_write_keys_entirely(self):
        out = extract_exact.tool_breakdown({"m": {"input": 5}}, extract_exact.CODEX_TYPES)
        self.assertNotIn("cache_write_5m", out["models"]["m"])

    def test_model_with_no_tokens_and_no_calls_is_dropped(self):
        out = extract_exact.tool_breakdown({"m": {}}, extract_exact.CODEX_TYPES)
        self.assertEqual(out["models"], {})

    def test_model_with_no_tokens_but_a_call_is_kept(self):
        out = extract_exact.tool_breakdown(
            {"m": {"calls": 1}}, extract_exact.CLAUDE_CODE_TYPES, with_calls=True
        )
        self.assertEqual(out["models"]["m"]["calls"], 1)
        self.assertEqual(out["models"]["m"]["tokens"], 0)

    def test_tokens_is_the_sum_of_the_type_keys(self):
        out = extract_exact.tool_breakdown(
            {"m": {"input": 1, "cache_write_5m": 2, "cache_write_1h": 4,
                   "cache_read": 8, "output": 16}},
            extract_exact.CLAUDE_CODE_TYPES,
        )
        self.assertEqual(out["models"]["m"]["tokens"], 31)

    def test_unattributed_defaults_to_zero(self):
        out = extract_exact.tool_breakdown({}, extract_exact.CODEX_TYPES)
        self.assertEqual(out, {"models": {}, "unattributed": 0})


class ExtractMainTests(FixtureHomeTestCase):
    """End-to-end: the two extractors merged and written to disk."""

    def setUp(self):
        super().setUp()
        self._real_out = extract_exact.OUT_DIR
        self._real_private = extract_exact.PRIVATE_DIR
        self._tmp = tempfile.TemporaryDirectory()
        out_dir = Path(self._tmp.name) / "data"
        extract_exact.OUT_DIR = out_dir
        extract_exact.PRIVATE_DIR = out_dir / "private"
        with redirect_stdout(StringIO()):
            extract_exact.main()
        self.raw = (out_dir / "exact-daily.json").read_text()
        self.rows = json.loads(self.raw)
        self.by_date = {r["date"]: r for r in self.rows}
        self.detail = json.loads((out_dir / "private" / "day-detail.json").read_text())

    def tearDown(self):
        extract_exact.OUT_DIR = self._real_out
        extract_exact.PRIVATE_DIR = self._real_private
        self._tmp.cleanup()
        super().tearDown()

    def test_rows_cover_the_union_of_both_sources_in_date_order(self):
        self.assertEqual(
            [r["date"] for r in self.rows],
            [
                "2026-07-16",
                "2026-07-17",
                "2026-07-18",
                "2026-07-19",
                "2026-07-20",
                "2026-07-21",
                "2026-07-22",
                "2026-07-23",
            ],
        )

    def test_aggregate_columns_keep_their_original_meaning(self):
        # These three predate the breakdown and are what the whole UI reads
        # today; the split is additive and must not disturb them.
        self.assertEqual(
            {k: v for k, v in self.by_date["2026-07-16"].items() if k != "breakdown"},
            {
                "date": "2026-07-16",
                "codex_tokens": 3000,
                "claude_code_tokens": 1181,
                "claude_code_calls": 4,
            },
        )
        # A day with Codex usage only still reports zeroed Claude Code fields.
        self.assertEqual(
            {k: v for k, v in self.by_date["2026-07-17"].items() if k != "breakdown"},
            {
                "date": "2026-07-17",
                "codex_tokens": 5000,
                "claude_code_tokens": 0,
                "claude_code_calls": 0,
            },
        )

    def test_every_row_carries_both_tools(self):
        for row in self.rows:
            with self.subTest(date=row["date"]):
                self.assertEqual(
                    sorted(row["breakdown"]), ["claude_code", "codex"]
                )
                for tool in row["breakdown"].values():
                    self.assertEqual(sorted(tool), ["models", "unattributed"])

    def test_breakdown_reconciles_with_both_aggregates(self):
        for row in self.rows:
            for tool, column in (
                ("claude_code", "claude_code_tokens"),
                ("codex", "codex_tokens"),
            ):
                with self.subTest(date=row["date"], tool=tool):
                    entry = row["breakdown"][tool]
                    typed = sum(m["tokens"] for m in entry["models"].values())
                    self.assertEqual(typed + entry["unattributed"], row[column])

    def test_output_is_byte_stable_across_runs(self):
        # The hourly cron commits this file; an unstable key order or a
        # key that appears only when nonzero means permanent diff noise.
        with redirect_stdout(StringIO()):
            extract_exact.main()
        self.assertEqual(
            (extract_exact.OUT_DIR / "exact-daily.json").read_text(), self.raw
        )

    def test_day_detail_merges_both_tools_under_one_project_key(self):
        # 07-16: 1181 from Claude Code + 3000 from Codex, same project.
        self.assertEqual(self.detail["2026-07-16"], {PROJECT_A: 4181})
        # 07-18: 10500 from Claude Code + 5200 from Codex.
        self.assertEqual(self.detail["2026-07-18"], {PROJECT_B: 15700})

    def test_day_detail_omits_days_with_no_attributable_project(self):
        self.assertNotIn("2026-07-19", self.detail)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
