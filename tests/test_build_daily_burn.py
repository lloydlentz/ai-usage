"""Tests for scripts/build_daily_burn.py.

The merge step writes an append-only ledger: once a row has captured nonzero
exact data, every exact column is held at the max of the captured value and
whatever extraction finds next. A regression here is baked into history
rather than corrected on the next run, so these tests pin that contract --
both that a shrinking column is refused, and that refusing it is announced
loudly enough to notice in the cron log.

All runs use a temp DATA directory and (where useful) a patched RANGE_START
so a test only walks the handful of days it cares about.
"""

import gc
import json
import tempfile
import unittest
import warnings
from contextlib import redirect_stdout
from datetime import date
from io import StringIO
from pathlib import Path

from ._loader import REPO_ROOT, load_script

build_daily_burn = load_script("build_daily_burn")

UNLABELED = ("unlabeled", "exact logs; add a driver label for this day")
# 2026-08-24..30 is a full Mon-Sun week with no DRIVERS entries.
WEEK_MON = "2026-08-24"
WEEK_TUE = "2026-08-25"
WEEK_WED = "2026-08-26"
WEEK_THU = "2026-08-27"
WEEK_FRI = "2026-08-28"
WEEK_SAT = "2026-08-29"
WEEK_SUN = "2026-08-30"


def exact_row(day, codex=0, claude_code=0, calls=0):
    return {
        "date": day,
        "codex_tokens": codex,
        "claude_code_tokens": claude_code,
        "claude_code_calls": calls,
    }


class HasExactDataTests(unittest.TestCase):
    def test_empty_row_is_not_exact(self):
        self.assertFalse(build_daily_burn.has_exact_data({}))

    def test_explicit_zeros_are_not_exact(self):
        self.assertFalse(
            build_daily_burn.has_exact_data(
                {"codex_tokens": 0, "claude_code_tokens": 0}
            )
        )

    def test_none_values_are_not_exact(self):
        # `or 0` has to absorb nulls; without it this raises TypeError.
        self.assertFalse(
            build_daily_burn.has_exact_data(
                {"codex_tokens": None, "claude_code_tokens": None}
            )
        )

    def test_call_count_alone_is_not_exact(self):
        # Calls without tokens must not freeze a row.
        self.assertFalse(build_daily_burn.has_exact_data({"claude_code_calls": 500}))

    def test_estimates_alone_are_not_exact(self):
        self.assertFalse(
            build_daily_burn.has_exact_data(
                {"claude_chat_est": 30_000, "chatgpt_est": 15_000, "gemini_est": 8_000}
            )
        )

    def test_either_source_alone_is_exact(self):
        self.assertTrue(build_daily_burn.has_exact_data({"codex_tokens": 1}))
        self.assertTrue(build_daily_burn.has_exact_data({"claude_code_tokens": 1}))

    def test_one_nonzero_with_the_other_zero_is_exact(self):
        self.assertTrue(
            build_daily_burn.has_exact_data(
                {"codex_tokens": 0, "claude_code_tokens": 1}
            )
        )


class BuildRowEstimateTests(unittest.TestCase):
    """Weekday estimate patterns (see ESTIMATES.md) and the total invariant."""

    def estimates(self, day):
        row = build_daily_burn.build_row(day, {}, None)
        return (row["claude_chat_est"], row["chatgpt_est"], row["gemini_est"])

    def test_weekday_patterns(self):
        self.assertEqual(self.estimates(WEEK_MON), (30_000, 15_000, 8_000))
        self.assertEqual(self.estimates(WEEK_TUE), (30_000, 0, 50_000))
        self.assertEqual(self.estimates(WEEK_WED), (30_000, 15_000, 0))
        self.assertEqual(self.estimates(WEEK_THU), (30_000, 0, 50_000))
        self.assertEqual(self.estimates(WEEK_FRI), (30_000, 15_000, 8_000))

    def test_weekends_get_no_estimates(self):
        self.assertEqual(self.estimates(WEEK_SAT), (0, 0, 0))
        self.assertEqual(self.estimates(WEEK_SUN), (0, 0, 0))

    def test_total_is_the_sum_of_all_five_columns(self):
        row = build_daily_burn.build_row(
            WEEK_WED, exact_row(WEEK_WED, codex=1_234, claude_code=5_678, calls=9), None
        )
        self.assertEqual(
            row["total"],
            row["codex_tokens"]
            + row["claude_code_tokens"]
            + row["claude_chat_est"]
            + row["chatgpt_est"]
            + row["gemini_est"],
        )
        self.assertEqual(row["total"], 1_234 + 5_678 + 30_000 + 15_000 + 0)

    def test_total_on_a_weekend_is_exact_data_only(self):
        row = build_daily_burn.build_row(
            WEEK_SAT, exact_row(WEEK_SAT, codex=700, claude_code=300), None
        )
        self.assertEqual(row["total"], 1_000)

    def test_call_count_is_carried_through(self):
        row = build_daily_burn.build_row(
            WEEK_MON, exact_row(WEEK_MON, claude_code=42, calls=7), None
        )
        self.assertEqual(row["claude_code_calls"], 7)


class BuildRowDriverTests(unittest.TestCase):
    def test_known_date_uses_the_drivers_table(self):
        row = build_daily_burn.build_row("2026-07-16", {}, None)
        self.assertEqual(
            (row["driver"], row["evidence"]), build_daily_burn.DRIVERS["2026-07-16"]
        )

    def test_drivers_table_wins_even_without_exact_data(self):
        # 2026-05-04 is in DRIVERS but has no exact tokens in the shipped data.
        row = build_daily_burn.build_row("2026-05-04", {}, None)
        self.assertEqual(row["driver"], "shipping")

    def test_exact_data_without_a_table_entry_is_unlabeled(self):
        self.assertNotIn(WEEK_THU, build_daily_burn.DRIVERS)
        row = build_daily_burn.build_row(
            WEEK_THU, exact_row(WEEK_THU, claude_code=5), None
        )
        self.assertEqual((row["driver"], row["evidence"]), UNLABELED)

    def test_codex_only_day_without_a_table_entry_is_unlabeled(self):
        row = build_daily_burn.build_row(WEEK_THU, exact_row(WEEK_THU, codex=5), None)
        self.assertEqual((row["driver"], row["evidence"]), UNLABELED)

    def test_no_exact_and_no_table_entry_is_chat_only(self):
        row = build_daily_burn.build_row(WEEK_THU, {}, None)
        self.assertEqual(
            (row["driver"], row["evidence"]), build_daily_burn.CHAT_ONLY
        )

    def test_frozen_exact_data_also_drives_the_unlabeled_branch(self):
        frozen = {
            "codex_tokens": 0,
            "claude_code_tokens": 900,
            "claude_code_calls": 3,
        }
        with redirect_stdout(StringIO()):
            row = build_daily_burn.build_row(WEEK_THU, {}, frozen)
        self.assertEqual((row["driver"], row["evidence"]), UNLABELED)
        self.assertEqual(row["claude_code_tokens"], 900)


class PartialRowTests(unittest.TestCase):
    """Rows in daily-burn.json predate the current schema and get hand-edited.

    Indexing an exact column directly used to raise KeyError, which kills
    the whole hourly refresh rather than just one day.
    """

    def build(self, ex, prev_exact):
        with redirect_stdout(StringIO()):
            return build_daily_burn.build_row("2026-07-16", ex, prev_exact)

    def test_previous_row_missing_every_exact_column(self):
        # A row carrying only estimates, as an old schema would have written.
        row = self.build({}, {"date": "2026-07-16", "claude_chat_est": 30_000})
        self.assertEqual(row["codex_tokens"], 0)
        self.assertEqual(row["claude_code_tokens"], 0)
        self.assertEqual(row["claude_code_calls"], 0)

    def test_previous_row_missing_only_the_call_count(self):
        # The realistic case: claude_code_calls was added after some rows
        # had already been written.
        row = self.build({}, {"codex_tokens": 500, "claude_code_tokens": 700})
        self.assertEqual(row["codex_tokens"], 500)
        self.assertEqual(row["claude_code_tokens"], 700)
        self.assertEqual(row["claude_code_calls"], 0)

    def test_null_values_in_a_previous_row_are_read_as_zero(self):
        row = self.build(
            exact_row("2026-07-16", codex=5, claude_code=6, calls=1),
            {"codex_tokens": None, "claude_code_tokens": None, "claude_code_calls": None},
        )
        self.assertEqual(row["codex_tokens"], 5)
        self.assertEqual(row["claude_code_tokens"], 6)
        self.assertEqual(row["claude_code_calls"], 1)

    def test_extracted_row_missing_columns_is_also_tolerated(self):
        row = self.build({"date": "2026-07-16"}, None)
        self.assertEqual(row["codex_tokens"], 0)
        self.assertEqual(row["claude_code_tokens"], 0)
        self.assertEqual(row["claude_code_calls"], 0)

    def test_count_helper_absorbs_missing_null_and_none_row(self):
        self.assertEqual(build_daily_burn.exact_count({}, "codex_tokens"), 0)
        self.assertEqual(build_daily_burn.exact_count({"codex_tokens": None}, "codex_tokens"), 0)
        self.assertEqual(build_daily_burn.exact_count(None, "codex_tokens"), 0)
        self.assertEqual(build_daily_burn.exact_count({"codex_tokens": 7}, "codex_tokens"), 7)


class LoadExistingTests(unittest.TestCase):
    def test_missing_file_returns_empty_mapping(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(
                build_daily_burn.load_existing(Path(tmp) / "nope.json"), {}
            )

    def test_rows_are_keyed_by_date(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "daily-burn.json"
            path.write_text(json.dumps([{"date": "2026-07-16", "total": 5}]))
            loaded = build_daily_burn.load_existing(path)
            self.assertEqual(
                loaded, {"2026-07-16": {"date": "2026-07-16", "total": 5}}
            )


class MainTestCase(unittest.TestCase):
    """Drive main() against a temp DATA dir and a narrow RANGE_START."""

    def setUp(self):
        self._real_data = build_daily_burn.DATA
        self._real_start = build_daily_burn.RANGE_START
        self._tmp = tempfile.TemporaryDirectory()
        self.data = Path(self._tmp.name)
        build_daily_burn.DATA = self.data

    def tearDown(self):
        build_daily_burn.DATA = self._real_data
        build_daily_burn.RANGE_START = self._real_start
        self._tmp.cleanup()

    def run_main(self, exact, existing=None, range_start=None):
        if range_start is not None:
            build_daily_burn.RANGE_START = range_start
        (self.data / "exact-daily.json").write_text(json.dumps(exact))
        if existing is not None:
            (self.data / "daily-burn.json").write_text(json.dumps(existing))
        buffer = StringIO()
        with redirect_stdout(buffer):
            build_daily_burn.main()
        self.stdout = buffer.getvalue()
        out_path = self.data / "daily-burn.json"
        if not out_path.exists():
            return {}
        rows = json.loads(out_path.read_text())
        return {row["date"]: row for row in rows}


class FreezingTests(MainTestCase):
    def test_row_with_exact_data_survives_the_logs_disappearing(self):
        previous = build_daily_burn.build_row(
            "2026-07-16", exact_row("2026-07-16", codex=3_000, claude_code=1_181, calls=4), None
        )
        rows = self.run_main(
            exact=[], existing=[previous], range_start=date(2026, 7, 16)
        )
        row = rows["2026-07-16"]
        self.assertEqual(row["codex_tokens"], 3_000)
        self.assertEqual(row["claude_code_tokens"], 1_181)
        self.assertEqual(row["claude_code_calls"], 4)
        self.assertIn("1 frozen from previous capture", self.stdout)

    def test_frozen_row_still_refreshes_estimates_and_label(self):
        stale = build_daily_burn.build_row(
            "2026-07-16", exact_row("2026-07-16", claude_code=1_181, calls=4), None
        )
        stale["claude_chat_est"] = 1
        stale["gemini_est"] = 1
        stale["driver"] = "stale"
        stale["evidence"] = "stale"
        rows = self.run_main(
            exact=[], existing=[stale], range_start=date(2026, 7, 16)
        )
        row = rows["2026-07-16"]
        self.assertEqual(row["claude_code_tokens"], 1_181)  # frozen
        self.assertEqual(row["claude_chat_est"], 30_000)  # refreshed
        self.assertEqual(row["gemini_est"], 50_000)  # refreshed (Thursday)
        self.assertEqual(
            (row["driver"], row["evidence"]), build_daily_burn.DRIVERS["2026-07-16"]
        )
        self.assertEqual(row["total"], 1_181 + 30_000 + 0 + 50_000)

    def test_estimate_only_row_is_allowed_to_update(self):
        stale = {
            "date": WEEK_FRI,
            "codex_tokens": 0,
            "claude_code_tokens": 0,
            "claude_code_calls": 0,
            "claude_chat_est": 1,
            "chatgpt_est": 1,
            "gemini_est": 1,
            "total": 3,
            "driver": "stale",
            "evidence": "stale",
        }
        rows = self.run_main(
            exact=[], existing=[stale], range_start=date(2026, 8, 28)
        )
        row = rows[WEEK_FRI]
        self.assertEqual(row["claude_chat_est"], 30_000)
        self.assertEqual(row["chatgpt_est"], 15_000)
        self.assertEqual(row["gemini_est"], 8_000)
        self.assertEqual(row["total"], 53_000)
        self.assertEqual(
            (row["driver"], row["evidence"]), build_daily_burn.CHAT_ONLY
        )
        self.assertIn("0 frozen from previous capture", self.stdout)

    def test_under_counted_extraction_cannot_shrink_a_captured_row(self):
        # The gap the `not ex` guard used to leave open: the day is still
        # present in exact-daily.json, just smaller than what was captured
        # (partial log pruning, a dedup regression, a changed log schema).
        # Every exact column takes the max, so history survives.
        previous = build_daily_burn.build_row(
            "2026-07-16", exact_row("2026-07-16", codex=3_000, claude_code=1_181, calls=4), None
        )
        rows = self.run_main(
            exact=[exact_row("2026-07-16", codex=0, claude_code=100, calls=1)],
            existing=[previous],
            range_start=date(2026, 7, 16),
        )
        row = rows["2026-07-16"]
        self.assertEqual(row["codex_tokens"], 3_000)
        self.assertEqual(row["claude_code_tokens"], 1_181)
        self.assertEqual(row["claude_code_calls"], 4)
        self.assertIn("1 frozen from previous capture", self.stdout)

    def test_shrinking_columns_are_each_announced_with_both_values(self):
        # max() also blocks legitimate downward corrections, so it must not
        # be silent -- this line is what shows up in the cron log at
        # /tmp/token-burn-refresh.log.
        previous = build_daily_burn.build_row(
            "2026-07-16", exact_row("2026-07-16", codex=3_000, claude_code=1_181, calls=4), None
        )
        self.run_main(
            exact=[exact_row("2026-07-16", codex=0, claude_code=100, calls=1)],
            existing=[previous],
            range_start=date(2026, 7, 16),
        )
        for column, captured, extracted in (
            ("codex_tokens", "3,000", "0"),
            ("claude_code_tokens", "1,181", "100"),
            ("claude_code_calls", "4", "1"),
        ):
            with self.subTest(column=column):
                self.assertIn(
                    f"2026-07-16 {column} keeps captured {captured} "
                    f"over extracted {extracted}",
                    self.stdout,
                )

    def test_growing_columns_are_taken_from_the_fresh_extraction(self):
        # The ledger is additive, not immutable: a day that legitimately
        # grows (a late session flushed to the logs) must still go up.
        previous = build_daily_burn.build_row(
            "2026-07-16", exact_row("2026-07-16", codex=100, claude_code=200, calls=1), None
        )
        rows = self.run_main(
            exact=[exact_row("2026-07-16", codex=3_000, claude_code=1_181, calls=4)],
            existing=[previous],
            range_start=date(2026, 7, 16),
        )
        row = rows["2026-07-16"]
        self.assertEqual(row["codex_tokens"], 3_000)
        self.assertEqual(row["claude_code_tokens"], 1_181)
        self.assertEqual(row["claude_code_calls"], 4)
        self.assertIn("0 frozen from previous capture", self.stdout)
        self.assertNotIn("keeps captured", self.stdout)

    def test_unchanged_row_produces_no_log_noise(self):
        # The common case, once an hour, every hour: extraction reproduces
        # exactly what was captured. Nothing is being held back, so nothing
        # should be reported -- otherwise the real warnings drown.
        captured = exact_row("2026-07-16", codex=3_000, claude_code=1_181, calls=4)
        previous = build_daily_burn.build_row("2026-07-16", captured, None)
        rows = self.run_main(
            exact=[captured], existing=[previous], range_start=date(2026, 7, 16)
        )
        row = rows["2026-07-16"]
        self.assertEqual(row["codex_tokens"], 3_000)
        self.assertEqual(row["claude_code_tokens"], 1_181)
        self.assertEqual(row["claude_code_calls"], 4)
        self.assertNotIn("keeps captured", self.stdout)
        self.assertIn("0 frozen from previous capture", self.stdout)

    def test_call_count_is_preserved_alongside_the_token_columns(self):
        # claude_code_calls is not part of has_exact_data(), but once the
        # row is known to be a real capture the call count is held to the
        # same rule as the tokens -- a row must never report 1,181 tokens
        # earned over 4 calls as having been earned over 1.
        previous = build_daily_burn.build_row(
            "2026-07-16", exact_row("2026-07-16", claude_code=1_181, calls=4), None
        )
        rows = self.run_main(
            exact=[exact_row("2026-07-16", claude_code=1_181, calls=1)],
            existing=[previous],
            range_start=date(2026, 7, 16),
        )
        self.assertEqual(rows["2026-07-16"]["claude_code_calls"], 4)


class MainRangeTests(MainTestCase):
    def test_empty_weekend_days_are_skipped_entirely(self):
        rows = self.run_main(
            exact=[exact_row("2026-07-20", claude_code=10)],
            range_start=date(2026, 7, 17),
        )
        # Fri 17 (estimates) and Mon 20 (exact) only; Sat 18 and Sun 19 have
        # no estimates, no exact data and no previous row, so they are dropped
        # rather than written as zero rows.
        self.assertEqual(sorted(rows), ["2026-07-17", "2026-07-20"])

    def test_weekend_with_exact_data_is_kept(self):
        rows = self.run_main(
            exact=[exact_row("2026-07-18", codex=7_500)],
            range_start=date(2026, 7, 18),
        )
        self.assertEqual(sorted(rows), ["2026-07-18"])
        self.assertEqual(rows["2026-07-18"]["total"], 7_500)

    def test_weekend_row_persists_once_written(self):
        previous = build_daily_burn.build_row(
            "2026-07-18", exact_row("2026-07-18", codex=7_500), None
        )
        rows = self.run_main(
            exact=[], existing=[previous], range_start=date(2026, 7, 18)
        )
        self.assertEqual(rows["2026-07-18"]["codex_tokens"], 7_500)

    def test_new_days_are_appended_and_rows_stay_date_sorted(self):
        previous = build_daily_burn.build_row(
            "2026-07-20", exact_row("2026-07-20", claude_code=10), None
        )
        self.run_main(
            exact=[exact_row("2026-07-22", claude_code=20)],
            existing=[previous],
            range_start=date(2026, 7, 20),
        )
        written = json.loads((self.data / "daily-burn.json").read_text())
        dates = [row["date"] for row in written]
        self.assertEqual(dates, ["2026-07-20", "2026-07-21", "2026-07-22"])
        self.assertEqual(dates, sorted(dates))

    def test_end_of_range_is_the_latest_date_across_both_sources(self):
        previous = build_daily_burn.build_row(
            "2026-07-22", exact_row("2026-07-22", claude_code=5), None
        )
        rows = self.run_main(
            exact=[exact_row("2026-07-20", claude_code=5)],
            existing=[previous],
            range_start=date(2026, 7, 20),
        )
        self.assertEqual(max(rows), "2026-07-22")

    def test_meta_json_records_a_chicago_timestamp(self):
        self.run_main(
            exact=[exact_row("2026-07-20", claude_code=10)],
            range_start=date(2026, 7, 20),
        )
        meta = json.loads((self.data / "meta.json").read_text())
        self.assertIn("refreshed_at", meta)
        # Chicago is UTC-5 or UTC-6, never UTC.
        self.assertRegex(meta["refreshed_at"], r"-0[56]:00$")

    def test_no_data_at_all_writes_nothing(self):
        rows = self.run_main(exact=[], range_start=date(2026, 7, 20))
        self.assertEqual(rows, {})
        self.assertFalse((self.data / "daily-burn.json").exists())
        self.assertIn("no data found", self.stdout)


class LegacyLedgerTests(MainTestCase):
    """A whole refresh must survive a ledger row written by an older schema."""

    def test_main_completes_with_a_previous_row_missing_exact_columns(self):
        legacy = {
            "date": "2026-07-16",
            "codex_tokens": 3_000,
            # claude_code_tokens / claude_code_calls absent entirely
            "claude_chat_est": 30_000,
            "chatgpt_est": 0,
            "gemini_est": 50_000,
            "total": 83_000,
            "driver": "research",
            "evidence": "exact logs",
        }
        rows = self.run_main(
            exact=[], existing=[legacy], range_start=date(2026, 7, 16)
        )
        row = rows["2026-07-16"]
        self.assertEqual(row["codex_tokens"], 3_000)
        self.assertEqual(row["claude_code_tokens"], 0)
        self.assertEqual(row["claude_code_calls"], 0)

    def test_main_completes_with_null_exact_columns(self):
        legacy = {
            "date": "2026-07-16",
            "codex_tokens": None,
            "claude_code_tokens": 1_181,
            "claude_code_calls": None,
            "claude_chat_est": 30_000,
            "chatgpt_est": 0,
            "gemini_est": 50_000,
            "total": 81_181,
            "driver": "research",
            "evidence": "exact logs",
        }
        rows = self.run_main(
            exact=[], existing=[legacy], range_start=date(2026, 7, 16)
        )
        row = rows["2026-07-16"]
        self.assertEqual(row["codex_tokens"], 0)
        self.assertEqual(row["claude_code_tokens"], 1_181)
        self.assertEqual(row["claude_code_calls"], 0)


class FileHandleTests(MainTestCase):
    def test_a_full_run_leaks_no_file_handles(self):
        # Both inputs are read inside `with` blocks. If either regresses to
        # `json.load(open(path))` the handle is only closed on collection
        # and CPython emits a ResourceWarning -- caught here rather than
        # suppressed, so the leak cannot go quiet again.
        previous = build_daily_burn.build_row(
            "2026-07-16", exact_row("2026-07-16", claude_code=1_181, calls=4), None
        )
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            self.run_main(
                exact=[exact_row("2026-07-16", claude_code=1_181, calls=4)],
                existing=[previous],
                range_start=date(2026, 7, 16),
            )
            gc.collect()
        leaks = [w for w in caught if issubclass(w.category, ResourceWarning)]
        self.assertEqual(
            leaks, [], f"unclosed file handles: {[str(w.message) for w in leaks]}"
        )


class RealDataInvariantTests(unittest.TestCase):
    """Cheap guards on the checked-in ledger itself."""

    @classmethod
    def setUpClass(cls):
        # Read via REPO_ROOT, not build_daily_burn.DATA, so this never picks
        # up a temp directory left in place by another test class.
        path = REPO_ROOT / "data" / "daily-burn.json"
        if not path.exists():  # pragma: no cover - data is committed
            raise unittest.SkipTest("data/daily-burn.json not present")
        cls.rows = json.loads(path.read_text())

    def test_totals_match_their_columns(self):
        for row in self.rows:
            with self.subTest(date=row["date"]):
                self.assertEqual(
                    row["total"],
                    row["codex_tokens"]
                    + row["claude_code_tokens"]
                    + row["claude_chat_est"]
                    + row["chatgpt_est"]
                    + row["gemini_est"],
                )

    def test_dates_are_unique_and_ascending(self):
        dates = [row["date"] for row in self.rows]
        self.assertEqual(len(dates), len(set(dates)))
        self.assertEqual(dates, sorted(dates))

    def test_no_row_predates_the_declared_range_start(self):
        for row in self.rows:
            self.assertGreaterEqual(
                date.fromisoformat(row["date"]), build_daily_burn.RANGE_START
            )


# ---------------------------------------------------------------------------
# Per-type breakdown, cost, and mixed fidelity
# ---------------------------------------------------------------------------

# A deliberately round rate card so every expected dollar figure below can be
# checked by hand. Shaped like the real one: an Anthropic-style model with all
# five types, and an OpenAI-style model with no cache-write rates at all.
RATES = {
    "m-claude": {
        "input": 1.0,
        "cache_write_5m": 1.25,
        "cache_write_1h": 2.0,
        "cache_read": 0.1,
        "output": 5.0,
    },
    "m-gpt": {"input": 2.0, "cache_read": 0.2, "output": 10.0},
}


def cc_entry(calls=1, input=0, cw5m=0, cw1h=0, cache_read=0, output=0):
    """One Claude Code model entry, in the shape extract_exact writes."""
    return {
        "calls": calls,
        "input": input,
        "cache_write_5m": cw5m,
        "cache_write_1h": cw1h,
        "cache_read": cache_read,
        "output": output,
        "tokens": input + cw5m + cw1h + cache_read + output,
    }


def codex_entry(input=0, cache_read=0, output=0):
    return {
        "input": input,
        "cache_read": cache_read,
        "output": output,
        "tokens": input + cache_read + output,
    }


def with_breakdown(row, claude_code=None, codex=None,
                   cc_unattributed=0, codex_unattributed=0):
    row["breakdown"] = {
        "claude_code": {
            "models": claude_code or {},
            "unattributed": cc_unattributed,
        },
        "codex": {"models": codex or {}, "unattributed": codex_unattributed},
    }
    return row


class PricingTableTests(unittest.TestCase):
    """The rate card is data, not logic -- but it still has to load right."""

    def test_missing_file_prices_everything_as_unknown_not_free(self):
        # The dangerous failure mode is a missing rate card silently
        # producing $0.00 across the board.
        with tempfile.TemporaryDirectory() as tmp:
            rates = build_daily_burn.load_pricing(Path(tmp) / "nope.json")
        self.assertEqual(rates, {})

    def test_aliases_resolve_to_their_target_rates(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pricing.json"
            path.write_text(
                json.dumps(
                    {
                        "models": {"real": {"usd_per_million": {"input": 3.0}}},
                        "aliases": {"real-20260101": "real"},
                    }
                )
            )
            rates = build_daily_burn.load_pricing(path)
        self.assertEqual(rates["real-20260101"], {"input": 3.0})

    def test_alias_to_a_missing_target_is_ignored_rather_than_empty(self):
        # An alias resolving to {} would price its model at zero. It must
        # stay absent so it is reported as unknown instead.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pricing.json"
            path.write_text(json.dumps({"models": {}, "aliases": {"a": "gone"}}))
            rates = build_daily_burn.load_pricing(path)
        self.assertNotIn("a", rates)


class ShippedPricingTests(unittest.TestCase):
    """Guards on the checked-in rate card itself."""

    @classmethod
    def setUpClass(cls):
        path = REPO_ROOT / "data" / "pricing.json"
        if not path.exists():  # pragma: no cover - data is committed
            raise unittest.SkipTest("data/pricing.json not present")
        cls.raw = json.loads(path.read_text())
        cls.rates = build_daily_burn.load_pricing(path)

    def test_every_model_documents_a_source_and_a_date(self):
        # A rate with no provenance cannot be checked or corrected later.
        for model, entry in self.raw["models"].items():
            with self.subTest(model=model):
                self.assertTrue(entry.get("source"), f"{model} has no source")
                self.assertRegex(entry.get("source_date", ""), r"^\d{4}-\d{2}-\d{2}$")

    def test_anthropic_cache_rates_follow_the_documented_multipliers(self):
        # read 0.1x, 5m write 1.25x, 1h write 2x of base input.
        for model, entry in self.raw["models"].items():
            if entry.get("provider") != "anthropic":
                continue
            rates = entry["usd_per_million"]
            with self.subTest(model=model):
                self.assertAlmostEqual(rates["cache_read"], rates["input"] * 0.1, 6)
                self.assertAlmostEqual(rates["cache_write_5m"], rates["input"] * 1.25, 6)
                self.assertAlmostEqual(rates["cache_write_1h"], rates["input"] * 2.0, 6)

    def test_openai_models_omit_cache_write_rates(self):
        # Absent, not zero: OpenAI bills no cache-write premium, and a 0.0
        # would read as "we priced it and it was free".
        for model, entry in self.raw["models"].items():
            if entry.get("provider") != "openai":
                continue
            with self.subTest(model=model):
                self.assertNotIn("cache_write_5m", entry["usd_per_million"])
                self.assertNotIn("cache_write_1h", entry["usd_per_million"])

    def test_output_costs_more_than_input_everywhere(self):
        for model, rates in self.rates.items():
            if not rates.get("input"):
                continue  # the zero-rated <synthetic> placeholder
            with self.subTest(model=model):
                self.assertGreater(rates["output"], rates["input"])

    def test_declared_basis_is_a_counterfactual(self):
        # The project's credibility rests on never implying a real invoice.
        self.assertEqual(self.raw["basis"], build_daily_burn.COST_BASIS)
        self.assertIn("counterfactual", build_daily_burn.COST_BASIS)


class CostMathTests(unittest.TestCase):
    def price(self, breakdown, rates=RATES):
        return build_daily_burn.price_breakdown(breakdown, rates)

    def test_each_type_is_priced_at_its_own_rate(self):
        bd = with_breakdown(
            {},
            claude_code={
                "m-claude": cc_entry(
                    input=1_000_000,
                    cw5m=1_000_000,
                    cw1h=1_000_000,
                    cache_read=10_000_000,
                    output=100_000,
                )
            },
        )["breakdown"]
        cost, _ = self.price(bd)
        self.assertEqual(
            cost["by_type"],
            {
                "input": 1.0,
                "cache_write_5m": 1.25,
                "cache_write_1h": 2.0,
                "cache_read": 1.0,
                "output": 0.5,
            },
        )
        self.assertEqual(cost["total"], 5.75)

    def test_cache_reads_dominate_volume_but_not_cost(self):
        # The reason the whole split exists. 10M of 13.1M tokens (76%) are
        # cache reads, but they are only $1.00 of $5.75 (17%). Summing the
        # types at equal weight makes a cached session look like real work.
        bd = with_breakdown(
            {},
            claude_code={
                "m-claude": cc_entry(
                    input=1_000_000,
                    cw5m=1_000_000,
                    cw1h=1_000_000,
                    cache_read=10_000_000,
                    output=100_000,
                )
            },
        )["breakdown"]
        cost, _ = self.price(bd)
        tokens = bd["claude_code"]["models"]["m-claude"]["tokens"]
        self.assertAlmostEqual(10_000_000 / tokens, 0.763, places=3)
        self.assertAlmostEqual(cost["by_type"]["cache_read"] / cost["total"], 0.174, places=3)

    def test_per_model_cost_is_written_onto_the_entry(self):
        bd = with_breakdown(
            {}, claude_code={"m-claude": cc_entry(output=1_000_000)}
        )["breakdown"]
        self.price(bd)
        self.assertEqual(bd["claude_code"]["models"]["m-claude"]["cost_usd"], 5.0)

    def test_by_tool_splits_the_two_sources(self):
        bd = with_breakdown(
            {},
            claude_code={"m-claude": cc_entry(output=1_000_000)},
            codex={"m-gpt": codex_entry(output=1_000_000)},
        )["breakdown"]
        cost, _ = self.price(bd)
        self.assertEqual(cost["by_tool"], {"claude_code": 5.0, "codex": 10.0})
        self.assertEqual(cost["total"], 15.0)

    def test_both_tools_always_appear_in_by_tool(self):
        cost, _ = self.price(with_breakdown({})["breakdown"])
        self.assertEqual(sorted(cost["by_tool"]), ["claude_code", "codex"])

    def test_rollups_agree_with_each_other(self):
        bd = with_breakdown(
            {},
            claude_code={
                "m-claude": cc_entry(input=123_456, cw1h=7_777, cache_read=9_999_999,
                                     output=4_321)
            },
            codex={"m-gpt": codex_entry(input=555, cache_read=88_888, output=1_234)},
        )["breakdown"]
        cost, _ = self.price(bd)
        self.assertAlmostEqual(sum(cost["by_type"].values()), cost["total"], places=5)
        self.assertAlmostEqual(sum(cost["by_tool"].values()), cost["total"], places=5)
        per_model = sum(
            m["cost_usd"]
            for tool in bd.values()
            for m in tool["models"].values()
        )
        self.assertAlmostEqual(per_model, cost["total"], places=5)

    def test_declares_its_basis_in_the_data(self):
        cost, _ = self.price(with_breakdown({})["breakdown"])
        self.assertEqual(cost["basis"], build_daily_burn.COST_BASIS)


class UnknownModelTests(unittest.TestCase):
    """Silent zeros are how a cost dashboard starts lying."""

    def setUp(self):
        self.bd = with_breakdown(
            {},
            claude_code={
                "m-claude": cc_entry(output=1_000_000),
                "m-brand-new": cc_entry(output=2_000_000),
            },
        )["breakdown"]
        self.cost, self.unpriced = build_daily_burn.price_breakdown(self.bd, RATES)

    def test_unknown_model_cost_is_null_not_zero(self):
        entry = self.bd["claude_code"]["models"]["m-brand-new"]
        self.assertIsNone(entry["cost_usd"])

    def test_unknown_model_tokens_are_counted_as_unpriced(self):
        self.assertEqual(self.cost["unpriced_tokens"], 2_000_000)

    def test_unknown_model_does_not_contribute_to_the_total(self):
        # The total stays a lower bound rather than absorbing a fake zero.
        self.assertEqual(self.cost["total"], 5.0)

    def test_known_models_alongside_it_still_price(self):
        self.assertEqual(self.bd["claude_code"]["models"]["m-claude"]["cost_usd"], 5.0)

    def test_unknown_model_is_reported_by_name_with_its_token_count(self):
        self.assertEqual(self.unpriced, {"m-brand-new": 2_000_000})

    def test_a_type_with_no_rate_on_a_known_model_is_unpriced_not_free(self):
        # e.g. an OpenAI model that starts reporting cache writes.
        bd = with_breakdown(
            {}, codex={"m-gpt": dict(codex_entry(output=1_000), cache_write_1h=500)}
        )["breakdown"]
        bd["codex"]["models"]["m-gpt"]["tokens"] += 500
        cost, unpriced = build_daily_burn.price_breakdown(bd, RATES)
        self.assertEqual(cost["unpriced_tokens"], 500)
        self.assertIn("m-gpt:cache_write_1h", unpriced)

    def test_unattributed_tokens_are_unpriced_by_definition(self):
        bd = with_breakdown({}, codex_unattributed=449_154)["breakdown"]
        cost, unpriced = build_daily_burn.price_breakdown(bd, RATES)
        self.assertEqual(cost["unpriced_tokens"], 449_154)
        self.assertEqual(unpriced["<unattributed>"], 449_154)
        self.assertEqual(cost["total"], 0.0)

    def test_empty_rate_card_prices_nothing_and_flags_everything(self):
        bd = with_breakdown(
            {}, claude_code={"m-claude": cc_entry(output=1_000_000)}
        )["breakdown"]
        cost, unpriced = build_daily_burn.price_breakdown(bd, {})
        self.assertEqual(cost["total"], 0.0)
        self.assertEqual(cost["unpriced_tokens"], 1_000_000)
        self.assertEqual(list(unpriced), ["m-claude"])


class BreakdownFreezingTests(unittest.TestCase):
    """The append-only guarantee has to cover the new columns too."""

    def build(self, ex, prev_exact):
        buffer = StringIO()
        with redirect_stdout(buffer):
            row = build_daily_burn.build_row(
                "2026-07-16", ex, prev_exact, rates=RATES
            )
        self.stdout = buffer.getvalue()
        return row

    def test_new_breakdown_is_written_onto_a_row_that_never_had_one(self):
        # Additive: new information about an old day is allowed in.
        prev = {"codex_tokens": 0, "claude_code_tokens": 900, "claude_code_calls": 3}
        ex = with_breakdown(
            exact_row("2026-07-16", claude_code=900, calls=3),
            claude_code={"m-claude": cc_entry(calls=3, output=900)},
        )
        row = self.build(ex, prev)
        self.assertEqual(row["breakdown"]["claude_code"]["models"]["m-claude"]["output"], 900)

    def test_captured_breakdown_survives_the_logs_disappearing(self):
        # Never overwrite a captured split with zeros.
        prev = with_breakdown(
            exact_row("2026-07-16", claude_code=900, calls=3),
            claude_code={"m-claude": cc_entry(calls=3, output=900)},
        )
        row = self.build({}, prev)
        self.assertEqual(
            row["breakdown"]["claude_code"]["models"]["m-claude"]["output"], 900
        )

    def test_shrinking_leaf_is_held_at_the_captured_value(self):
        prev = with_breakdown(
            exact_row("2026-07-16", claude_code=900, calls=3),
            claude_code={"m-claude": cc_entry(calls=3, output=900)},
        )
        ex = with_breakdown(
            exact_row("2026-07-16", claude_code=100, calls=1),
            claude_code={"m-claude": cc_entry(calls=1, output=100)},
        )
        row = self.build(ex, prev)
        entry = row["breakdown"]["claude_code"]["models"]["m-claude"]
        self.assertEqual(entry["output"], 900)
        self.assertEqual(entry["calls"], 3)
        self.assertEqual(entry["tokens"], 900)

    def test_shrinking_leaf_is_announced_with_both_values(self):
        # Same contract as the aggregate columns: max() blocks legitimate
        # downward corrections, so it must never be silent.
        prev = with_breakdown(
            exact_row("2026-07-16", claude_code=900, calls=3),
            claude_code={"m-claude": cc_entry(calls=3, output=900)},
        )
        ex = with_breakdown(
            exact_row("2026-07-16", claude_code=100, calls=1),
            claude_code={"m-claude": cc_entry(calls=1, output=100)},
        )
        self.build(ex, prev)
        self.assertIn(
            "2026-07-16 breakdown.claude_code.m-claude.output keeps captured 900 "
            "over extracted 100",
            self.stdout,
        )

    def test_growing_leaf_takes_the_fresh_value(self):
        prev = with_breakdown(
            exact_row("2026-07-16", claude_code=100, calls=1),
            claude_code={"m-claude": cc_entry(calls=1, output=100)},
        )
        ex = with_breakdown(
            exact_row("2026-07-16", claude_code=900, calls=3),
            claude_code={"m-claude": cc_entry(calls=3, output=900)},
        )
        row = self.build(ex, prev)
        self.assertEqual(
            row["breakdown"]["claude_code"]["models"]["m-claude"]["output"], 900
        )
        self.assertNotIn("keeps captured", self.stdout)

    def test_a_model_the_captured_row_never_saw_is_added(self):
        prev = with_breakdown(
            exact_row("2026-07-16", claude_code=100, calls=1),
            claude_code={"m-claude": cc_entry(calls=1, output=100)},
        )
        ex = with_breakdown(
            exact_row("2026-07-16", claude_code=300, calls=2),
            claude_code={
                "m-claude": cc_entry(calls=1, output=100),
                "m-gpt": cc_entry(calls=1, output=200),
            },
        )
        row = self.build(ex, prev)
        self.assertEqual(
            sorted(row["breakdown"]["claude_code"]["models"]), ["m-claude", "m-gpt"]
        )

    def test_a_model_only_the_captured_row_saw_is_kept(self):
        prev = with_breakdown(
            exact_row("2026-07-16", claude_code=300, calls=2),
            claude_code={
                "m-claude": cc_entry(calls=1, output=100),
                "m-gone": cc_entry(calls=1, output=200),
            },
        )
        ex = with_breakdown(
            exact_row("2026-07-16", claude_code=100, calls=1),
            claude_code={"m-claude": cc_entry(calls=1, output=100)},
        )
        row = self.build(ex, prev)
        self.assertEqual(
            row["breakdown"]["claude_code"]["models"]["m-gone"]["output"], 200
        )

    def test_cost_is_recomputed_rather_than_frozen(self):
        # Token counts are measurements and are frozen; cost is derived, so
        # correcting a rate must reprice the whole ledger.
        prev = with_breakdown(
            exact_row("2026-07-16", claude_code=1_000_000, calls=1),
            claude_code={"m-claude": cc_entry(calls=1, output=1_000_000)},
        )
        prev["cost_usd"] = {"total": 999.0}
        row = self.build({}, prev)
        self.assertEqual(row["cost_usd"]["total"], 5.0)


class UnattributedReconciliationTests(unittest.TestCase):
    """sum(model tokens) + unattributed == the tool's aggregate column."""

    def build(self, ex, prev_exact=None):
        with redirect_stdout(StringIO()):
            return build_daily_burn.build_row(
                "2026-07-16", ex, prev_exact, rates=RATES
            )

    def test_import_shaped_tokens_stay_in_the_aggregate_as_unattributed(self):
        ex = with_breakdown(
            exact_row("2026-07-16", codex=449_154), codex_unattributed=449_154
        )
        row = self.build(ex)
        self.assertEqual(row["codex_tokens"], 449_154)
        self.assertEqual(row["breakdown"]["codex"]["unattributed"], 449_154)
        self.assertEqual(row["breakdown"]["codex"]["models"], {})

    def test_a_frozen_aggregate_larger_than_its_split_becomes_unattributed(self):
        # The mixed-fidelity case that would otherwise let the breakdown
        # quietly under-report the headline sitting next to it.
        prev = exact_row("2026-07-16", claude_code=1000, calls=5)
        ex = with_breakdown(
            exact_row("2026-07-16", claude_code=400, calls=2),
            claude_code={"m-claude": cc_entry(calls=2, output=400)},
        )
        row = self.build(ex, prev)
        self.assertEqual(row["claude_code_tokens"], 1000)  # frozen
        self.assertEqual(row["breakdown"]["claude_code"]["unattributed"], 600)

    def test_invariant_holds_for_both_tools(self):
        ex = with_breakdown(
            exact_row("2026-07-16", codex=5_000, claude_code=1_500, calls=2),
            claude_code={"m-claude": cc_entry(calls=2, input=500, output=1_000)},
            codex={"m-gpt": codex_entry(input=1_000, cache_read=3_000, output=1_000)},
        )
        row = self.build(ex)
        for tool, column in build_daily_burn.BREAKDOWN_TOOLS.items():
            with self.subTest(tool=tool):
                entry = row["breakdown"][tool]
                typed = sum(m["tokens"] for m in entry["models"].values())
                self.assertEqual(typed + entry["unattributed"], row[column])

    def test_a_split_exceeding_its_aggregate_is_announced(self):
        ex = with_breakdown(
            exact_row("2026-07-16", claude_code=100),
            claude_code={"m-claude": cc_entry(output=500)},
        )
        buffer = StringIO()
        with redirect_stdout(buffer):
            build_daily_burn.build_row("2026-07-16", ex, None, rates=RATES)
        self.assertIn("the split exceeds its aggregate", buffer.getvalue())


class MixedFidelityTests(unittest.TestCase):
    """`cost_usd` must mean exactly one thing when it is absent."""

    def build(self, ex, prev_exact=None):
        with redirect_stdout(StringIO()):
            return build_daily_burn.build_row(
                "2026-07-16", ex, prev_exact, rates=RATES
            )

    def test_estimate_only_day_has_neither_breakdown_nor_cost(self):
        row = self.build({})
        self.assertNotIn("breakdown", row)
        self.assertNotIn("cost_usd", row)

    def test_tokens_without_a_breakdown_still_report_a_cost_block(self):
        # Otherwise a missing cost_usd would mean "$0" on some rows and
        # "unknown" on others, which a cost dashboard cannot afford.
        prev = exact_row("2026-07-16", claude_code=900, codex=100, calls=3)
        row = self.build({}, prev)
        self.assertNotIn("breakdown", row)
        self.assertIn("cost_usd", row)

    def test_an_unsplit_day_reports_all_its_tokens_as_unpriced(self):
        prev = exact_row("2026-07-16", claude_code=900, codex=100, calls=3)
        row = self.build({}, prev)
        self.assertEqual(row["cost_usd"]["unpriced_tokens"], 1000)
        self.assertEqual(row["cost_usd"]["total"], 0.0)

    def test_an_unsplit_day_is_reported_by_name(self):
        prev = exact_row("2026-07-16", claude_code=900, calls=3)
        out = {}
        with redirect_stdout(StringIO()):
            build_daily_burn.build_row(
                "2026-07-16", {}, prev, rates=RATES, unpriced_out=out
            )
        self.assertEqual(out, {"<no breakdown captured>": {"2026-07-16": 900}})

    def test_a_split_day_has_both_and_no_unpriced_tokens(self):
        ex = with_breakdown(
            exact_row("2026-07-16", claude_code=900, calls=3),
            claude_code={"m-claude": cc_entry(calls=3, output=900)},
        )
        row = self.build(ex)
        self.assertIn("breakdown", row)
        self.assertEqual(row["cost_usd"]["unpriced_tokens"], 0)
        self.assertGreater(row["cost_usd"]["total"], 0)

    def test_the_five_estimated_columns_are_never_priced(self):
        # Claude chat / ChatGPT / Gemini estimates are guesses, not
        # measurements; pricing them would launder an estimate into a
        # dollar figure.
        row = self.build({})
        self.assertGreater(row["claude_chat_est"], 0)
        self.assertNotIn("cost_usd", row)


class MainCostTests(MainTestCase):
    def test_meta_carries_a_labeled_counterfactual_total(self):
        self.run_main(
            exact=[
                with_breakdown(
                    exact_row("2026-07-20", claude_code=1_000_000, calls=1),
                    claude_code={"m-claude": cc_entry(calls=1, output=1_000_000)},
                )
            ],
            range_start=date(2026, 7, 20),
        )
        meta = json.loads((self.data / "meta.json").read_text())
        self.assertEqual(meta["cost"]["basis"], build_daily_burn.COST_BASIS)
        self.assertIn("not", meta["cost"]["disclaimer"])
        self.assertIn("actually spent", meta["cost"]["disclaimer"])

    def test_unknown_model_warning_names_the_model_and_the_days(self):
        self.run_main(
            exact=[
                with_breakdown(
                    exact_row("2026-07-20", claude_code=500, calls=1),
                    claude_code={"m-nobody-knows": cc_entry(calls=1, output=500)},
                ),
                with_breakdown(
                    exact_row("2026-07-21", claude_code=700, calls=1),
                    claude_code={"m-nobody-knows": cc_entry(calls=1, output=700)},
                ),
            ],
            range_start=date(2026, 7, 20),
        )
        self.assertIn("UNPRICED", self.stdout)
        self.assertIn("m-nobody-knows", self.stdout)
        self.assertIn("1,200 tokens", self.stdout)
        self.assertIn("2026-07-20, 2026-07-21", self.stdout)
        self.assertIn("not zero", self.stdout)

    def test_meta_lists_every_unpriced_model(self):
        self.run_main(
            exact=[
                with_breakdown(
                    exact_row("2026-07-20", claude_code=500, calls=1),
                    claude_code={"m-nobody-knows": cc_entry(calls=1, output=500)},
                )
            ],
            range_start=date(2026, 7, 20),
        )
        meta = json.loads((self.data / "meta.json").read_text())
        self.assertEqual(meta["cost"]["unpriced_models"], ["m-nobody-knows"])
        self.assertEqual(meta["cost"]["unpriced_tokens"], 500)

    def test_missing_rate_card_is_announced_loudly(self):
        real = build_daily_burn.PRICING_PATH
        build_daily_burn.PRICING_PATH = self.data / "nope.json"
        try:
            self.run_main(
                exact=[
                    with_breakdown(
                        exact_row("2026-07-20", claude_code=500, calls=1),
                        claude_code={"m-claude": cc_entry(calls=1, output=500)},
                    )
                ],
                range_start=date(2026, 7, 20),
            )
        finally:
            build_daily_burn.PRICING_PATH = real
        self.assertIn("no rate card", self.stdout)
        self.assertIn("unknown, not zero", self.stdout)


class RealDataBreakdownTests(unittest.TestCase):
    """Invariants on the shipped ledger, which the cron rewrites hourly."""

    @classmethod
    def setUpClass(cls):
        path = REPO_ROOT / "data" / "daily-burn.json"
        if not path.exists():  # pragma: no cover - data is committed
            raise unittest.SkipTest("data/daily-burn.json not present")
        cls.rows = json.loads(path.read_text())
        cls.split = [r for r in cls.rows if "breakdown" in r]

    def test_some_rows_carry_a_breakdown(self):
        self.assertTrue(self.split, "no row has a breakdown; extraction is broken")

    def test_every_breakdown_reconciles_with_its_aggregate(self):
        for row in self.split:
            for tool, column in build_daily_burn.BREAKDOWN_TOOLS.items():
                with self.subTest(date=row["date"], tool=tool):
                    entry = row["breakdown"][tool]
                    typed = sum(m["tokens"] for m in entry["models"].values())
                    self.assertEqual(typed + entry["unattributed"], row[column])

    def test_every_model_entry_sums_to_its_tokens(self):
        for row in self.split:
            for tool, entry in row["breakdown"].items():
                for model, counts in entry["models"].items():
                    with self.subTest(date=row["date"], model=model):
                        self.assertEqual(
                            sum(
                                counts.get(t, 0)
                                for t in build_daily_burn.TOKEN_TYPES
                            ),
                            counts["tokens"],
                        )

    def test_cost_is_present_on_exactly_the_rows_with_exact_tokens(self):
        # The contract the UI relies on: no cost_usd means no measured
        # usage, never "we measured it and it was free".
        for row in self.rows:
            has_tokens = build_daily_burn.has_exact_data(row)
            with self.subTest(date=row["date"]):
                self.assertEqual("cost_usd" in row, has_tokens)

    def test_cost_rollups_agree_on_every_row(self):
        for row in self.split:
            cost = row["cost_usd"]
            with self.subTest(date=row["date"]):
                self.assertAlmostEqual(
                    sum(cost["by_type"].values()), cost["total"], places=4
                )
                self.assertAlmostEqual(
                    sum(cost["by_tool"].values()), cost["total"], places=4
                )

    def test_no_priced_model_is_silently_free(self):
        # A model that priced to exactly $0 with nonzero tokens would mean
        # a rate went missing without anyone noticing.
        for row in self.split:
            for tool, entry in row["breakdown"].items():
                for model, counts in entry["models"].items():
                    if counts.get("cost_usd") is None or not counts["tokens"]:
                        continue
                    if model == "<synthetic>":
                        continue  # explicitly zero-rated, see pricing.json
                    with self.subTest(date=row["date"], model=model):
                        self.assertGreater(counts["cost_usd"], 0)

    def test_every_model_in_the_ledger_has_a_rate(self):
        rates = build_daily_burn.load_pricing()
        missing = {
            model
            for row in self.split
            for entry in row["breakdown"].values()
            for model in entry["models"]
            if model not in rates
        }
        self.assertEqual(missing, set(), f"add these to data/pricing.json: {missing}")

    def test_cost_declares_its_basis_on_every_row(self):
        for row in self.rows:
            if "cost_usd" not in row:
                continue
            with self.subTest(date=row["date"]):
                self.assertEqual(row["cost_usd"]["basis"], build_daily_burn.COST_BASIS)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
