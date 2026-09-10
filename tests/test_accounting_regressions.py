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

class CounterRegressionTests(unittest.TestCase):
    def extract_events(self, usages):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / ".codex/sessions/counters.jsonl"
            path.parent.mkdir(parents=True)
            events = [{"type": "turn_context", "payload": {"model": "test-model"}}]
            events += [{"timestamp": "2026-09-06T15:00:00Z", "payload": {"type": "token_count", "info": {"total_token_usage": usage}}} for usage in usages]
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
