"""Counterexamples found in September logs, with synthetic non-private inputs."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import redirect_stdout
from io import StringIO
from ._loader import load_script

extract = load_script("extract_exact")
build = load_script("build_daily_burn")
labels = load_script("import_driver_labels")

def codex_usage(total, inp, cached, out):
    """A Codex usage object; cached is a subset of input, not a sibling."""
    return {"total_tokens": total, "input_tokens": inp, "cached_input_tokens": cached, "output_tokens": out}

class CounterRegressionTests(unittest.TestCase):
    def extract_events(self, usages, lasts=None, minutes=None):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / ".codex/sessions/counters.jsonl"
            path.parent.mkdir(parents=True)
            events = [{"type": "turn_context", "payload": {"model": "test-model"}}]
            for i, usage in enumerate(usages):
                info = {"total_token_usage": usage}
                if lasts is not None:
                    info["last_token_usage"] = lasts[i]
                minute = minutes[i] if minutes is not None else 0
                events.append({"timestamp": f"2026-09-06T15:{minute:02d}:00Z", "payload": {"type": "token_count", "info": info}})
            path.write_text("\n".join(json.dumps(e) for e in events))
            with patch.object(extract, "HOME", root), redirect_stdout(StringIO()):
                return extract.extract_codex()

    def test_advancing_total_with_excess_type_delta_is_unattributed(self):
        # Total is authoritative; the independent input mark would add 100
        # despite the session only gaining 50 measured tokens.
        tokens, _, models, unknown = self.extract_events([
            {"total_tokens": 1000, "input_tokens": 900, "cached_input_tokens": 500, "output_tokens": 100},
            {"total_tokens": 1050, "input_tokens": 1000, "cached_input_tokens": 550, "output_tokens": 50},
            {"total_tokens": 1100, "input_tokens": 1030, "cached_input_tokens": 560, "output_tokens": 70},
        ])
        self.assertEqual(tokens["2026-09-06"], 1100)
        self.assertEqual(unknown["2026-09-06"], 70)
        self.assertEqual(sum(models["2026-09-06"]["test-model"].values()) + unknown["2026-09-06"], 1100)

    def test_cached_delta_larger_than_input_has_no_invented_split(self):
        tokens, _, models, unknown = self.extract_events([
            {"total_tokens": 100, "input_tokens": 100, "cached_input_tokens": 150},
        ])
        self.assertEqual(tokens["2026-09-06"], 100)
        self.assertEqual(unknown["2026-09-06"], 100)
        self.assertEqual(sum(models["2026-09-06"]["test-model"].values()), 0)

    def test_new_cache_write_schema_is_unknown_instead_of_free(self):
        _, _, _, unknown = self.extract_events([
            {"total_tokens": 100, "input_tokens": 100, "cache_write_input_tokens": 20},
        ])
        self.assertEqual(unknown["2026-09-06"], 100)

    # Counter restarts (September 12 survey): newer Codex Desktop builds
    # restart the cumulative counter mid-session. A restart holds one
    # response, so its total equals its own last_token_usage total.

    def test_counter_restart_starts_a_new_segment(self):
        # The bare high-water mark scored this 250 and dropped everything
        # after the restart; the true burn is 250 + 90.
        tokens, _, models, unknown = self.extract_events(
            [codex_usage(100, 80, 30, 20), codex_usage(250, 200, 120, 50), codex_usage(40, 30, 10, 10), codex_usage(90, 70, 35, 20)],
            lasts=[codex_usage(100, 80, 30, 20), codex_usage(150, 120, 90, 30), codex_usage(40, 30, 10, 10), codex_usage(50, 40, 25, 10)],
            minutes=[0, 1, 2, 3],
        )
        self.assertEqual(tokens["2026-09-06"], 340)
        self.assertNotIn("2026-09-06", unknown)
        # Per-type marks restart with the total: cached 120 + 35, uncached
        # (200 - 120) + (70 - 35), output 50 + 20. Stale marks would have
        # quarantined the second segment's split as ambiguous.
        self.assertEqual(dict(models["2026-09-06"]["test-model"]), {"input": 115, "cache_read": 155, "output": 70})

    def test_dip_without_the_restart_signature_is_still_a_stale_line(self):
        # 5000 -> 2000 -> 5200, where the 2000 line's last_token_usage is
        # not its total: a stale or replayed line, not a fresh counter. The
        # high-water mark still scores the true 5200, not 5000+2000+3200.
        tokens, _, _, _ = self.extract_events(
            [{"total_tokens": 5000}, {"total_tokens": 2000}, {"total_tokens": 5200}],
            lasts=[{"total_tokens": 5000}, {"total_tokens": 300}, {"total_tokens": 200}],
            minutes=[0, 1, 2],
        )
        self.assertEqual(tokens["2026-09-06"], 5200)

    def test_restart_above_a_one_response_segment_is_still_a_restart(self):
        # Real shape (2026-09-05): back-to-back restarts, 44,399 then
        # 46,059. The second total is above the mark, but a running segment
        # can never total its own last response while the mark is positive,
        # so it is a fresh counter: 100 + 60 + 75, not 100 + 60 + 15.
        tokens, _, _, unknown = self.extract_events(
            [codex_usage(100, 80, 30, 20), codex_usage(60, 50, 20, 10), codex_usage(75, 60, 30, 15)],
            lasts=[codex_usage(100, 80, 30, 20), codex_usage(60, 50, 20, 10), codex_usage(75, 60, 30, 15)],
            minutes=[0, 1, 2],
        )
        self.assertEqual(tokens["2026-09-06"], 235)
        self.assertNotIn("2026-09-06", unknown)

    def test_flat_repeat_of_a_restart_line_adds_nothing(self):
        # Real shape (2026-09-11): a restart line written twice. The repeat
        # sits at the mark, so it is not a second restart.
        tokens, _, _, _ = self.extract_events(
            [codex_usage(100, 80, 30, 20), codex_usage(40, 30, 10, 10), codex_usage(40, 30, 10, 10), codex_usage(90, 70, 35, 20)],
            lasts=[codex_usage(100, 80, 30, 20), codex_usage(40, 30, 10, 10), codex_usage(40, 30, 10, 10), codex_usage(50, 40, 25, 10)],
            minutes=[0, 1, 2, 3],
        )
        self.assertEqual(tokens["2026-09-06"], 190)

    def test_back_dated_restart_shaped_line_is_stale(self):
        # A replay of an old one-response line has the restart shape but an
        # older timestamp than one already seen; it must not reopen a segment.
        tokens, _, _, _ = self.extract_events(
            [codex_usage(100, 80, 30, 20), codex_usage(250, 200, 120, 50), codex_usage(100, 80, 30, 20), codex_usage(300, 240, 150, 60)],
            lasts=[codex_usage(100, 80, 30, 20), codex_usage(150, 120, 90, 30), codex_usage(100, 80, 30, 20), codex_usage(50, 40, 30, 10)],
            minutes=[0, 5, 0, 10],
        )
        self.assertEqual(tokens["2026-09-06"], 300)

class RepairTests(unittest.TestCase):
    def test_repair_requires_complete_source_and_preserves_original(self):
        day = "2026-09-06"
        captured = {day: {"date": day, "codex_tokens": 100, "breakdown": {"codex": {"models": {"m": {"input": 120, "tokens": 120}}, "unattributed": 0}}}}
        original = copy.deepcopy(captured)
        fresh = {day: {"date": day, "codex_tokens": 100, "breakdown": {"codex": {"models": {}, "unattributed": 100}}}}
        with tempfile.TemporaryDirectory() as folder, patch.object(build, "DATA", Path(folder)):
            repaired = build.repair_codex_breakdowns(captured, fresh, [day])
            self.assertEqual(repaired[day]["codex_tokens"], 100)
            self.assertEqual(repaired[day]["breakdown"], fresh[day]["breakdown"])
            self.assertEqual(captured, original)
            backups = list((Path(folder)/"private").glob("before-codex-repair-*.json"))
            self.assertEqual(json.loads(backups[0].read_text()), original)
            fresh[day]["codex_tokens"] = 99
            with self.assertRaisesRegex(ValueError, "does not cover"):
                build.repair_codex_breakdowns(captured, fresh, [day])

    def test_per_leaf_max_cannot_publish_a_split_larger_than_total(self):
        day = "2026-09-06"
        fresh = {"codex_tokens": 100, "breakdown": {"codex": {"models": {"m": {"input": 100, "output": 0, "tokens": 100}}}}}
        captured = {"codex_tokens": 100, "breakdown": {"codex": {"models": {"m": {"input": 0, "output": 100, "tokens": 100}}}}}
        with redirect_stdout(StringIO()), self.assertRaises(ValueError):
            build.build_row(day, fresh, captured, rates={})

    def test_import_rejects_paths_and_free_text(self):
        with self.assertRaises(ValueError):
            labels.validate_labels({"version": 1, "labels": {"2026-09-06": "/Users/private/client"}}, {"2026-09-06"})
        with self.assertRaises(ValueError):
            labels.validate_labels({"version": 1, "labels": {"2099-01-01": "research"}}, {"2026-09-06"})
        self.assertEqual(labels.validate_labels({"version": 1, "labels": {"2026-09-06": "review"}}, {"2026-09-06"}), {"2026-09-06": "review"})

    def test_partial_model_price_reports_unknown_token_count(self):
        split = {"codex": {"models": {"m": {"input": 100, "output": 50, "tokens": 150}}, "unattributed": 0}}
        cost, _ = build.price_breakdown(split, {"m": {"input": 1}})
        self.assertEqual(cost["unpriced_tokens"], 50)
        self.assertEqual(split["codex"]["models"]["m"]["unpriced_tokens"], 50)

class PublishedDataTests(unittest.TestCase):
    def test_committed_prices_match_current_card(self):
        rows = json.loads((build.DATA / "daily-burn.json").read_text())
        rates = build.load_pricing()
        for row in rows:
            if not row.get("breakdown"):
                continue
            with self.subTest(day=row["date"]):
                recomputed, _ = build.price_breakdown(copy.deepcopy(row["breakdown"]), rates)
                self.assertEqual(row["cost_usd"], recomputed)

    def test_published_labels_match_reviewed_overrides(self):
        rows = {r["date"]: r for r in json.loads((build.DATA / "daily-burn.json").read_text())}
        overrides = json.loads((build.ROOT / "scripts/driver-labels.json").read_text())
        for day, category in overrides.items():
            self.assertIn(day, rows)
            self.assertEqual(rows[day]["driver"], category)

    def test_committed_threads_fit_the_ledger_and_match_the_card(self):
        threads = json.loads((build.DATA / "threads.json").read_text())
        rows = json.loads((build.DATA / "daily-burn.json").read_text())
        build.validate_threads(threads, rows)
        rates = build.load_pricing()
        for thread in threads:
            for day, entry in thread["days"].items():
                with self.subTest(thread=thread["key"], day=day):
                    split = copy.deepcopy({"models": entry["models"], "unattributed": entry["unattributed"]})
                    cost, _ = build.price_breakdown({thread["tool"]: split}, rates)
                    self.assertEqual((entry["cost_usd"], entry["unpriced_tokens"]), (cost["total"], cost["unpriced_tokens"]))
