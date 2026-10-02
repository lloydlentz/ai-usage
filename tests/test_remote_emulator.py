"""Optional real SDK/Firestore integration. Requires FIRESTORE_EMULATOR_HOST.

FIRESTORE_EMULATOR_HOST=127.0.0.1:8287 .venv-remote/bin/python -m unittest tests.test_remote_emulator -v
"""
from __future__ import annotations

import copy
import json
import os
import tempfile
import unittest
import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
from unittest.mock import patch

from tests._loader import load_script
from tests.test_remote_usage import record

remote = load_script("remote_usage")
build = load_script("build_daily_burn")


@unittest.skipUnless(os.environ.get("FIRESTORE_EMULATOR_HOST"), "Firestore emulator not requested")
class FirestoreIntegrationTests(unittest.TestCase):
    def test_initialize_pins_history_and_rejects_second_migration(self):
        settings = {"project_id": "demo-ai-usage", "machine_id": "primary"}
        sdk, root = remote.connect(settings, "test_" + uuid.uuid4().hex)
        today = datetime.now(timezone.utc).astimezone(ZoneInfo("America/Chicago")).date().isoformat()
        first = record(day=today)
        baseline = {"date": today, "codex_tokens": 100, "claude_code_tokens": 0,
                    "claude_code_calls": 0, "breakdown": {"codex": first["counts"]}}
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory)
            (fixture / "data/private").mkdir(parents=True)
            (fixture / "data/daily-burn.json").write_text(json.dumps([baseline]))
            (fixture / "data/threads.json").write_text("[]")
            with patch.object(remote, "ROOT", fixture), patch.object(remote, "PRIVATE", fixture / "data/private"), \
                    patch.object(remote, "capture", return_value={first["id"]: first}), patch.object(build, "main"):
                remote.initialize(settings, root, sdk)
                self.assertEqual(root.get().to_dict()["schema"], 1)
                doc = root.collection("usage").document(first["id"]).get().to_dict()
                self.assertEqual(doc["baseline"], first["counts"])
                rows, _ = remote.aggregate([baseline], [], [doc])
                self.assertEqual(rows[0]["codex_tokens"], 100)
                self.assertTrue((fixture / "data/private/remote-migration.json").exists())
                with self.assertRaisesRegex(ValueError, "already initialized"):
                    remote.initialize(settings, root, sdk)

    def test_transactions_retry_duplicate_machines_and_report_bundle(self):
        settings = {"project_id": "demo-ai-usage", "machine_id": "laptop"}
        sdk, root = remote.connect(settings, "test_" + uuid.uuid4().hex)
        root.create({"schema": 1, "cutover": "2026-10-02T12:00:00+00:00", "primary": "laptop"})
        initial = record(tokens=100)
        baseline = {"date": "2026-10-02", "codex_tokens": 1000, "claude_code_tokens": 0, "claude_code_calls": 0}
        root.collection("baseline_days").document(baseline["date"]).create(baseline)
        root.collection("usage").document(initial["id"]).create({"record": initial, "baseline": initial["counts"]})
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory) / "private"
            private.mkdir()
            (private / "collection.json").write_text(json.dumps({"sources_available": {"codex": True, "claude_code": True}}))
            grown = record(tokens=150)
            with patch.object(remote, "PRIVATE", private), patch.object(remote, "capture", return_value={grown["id"]: grown}):
                remote.upload(settings, root, sdk)
                remote.upload(settings, root, sdk)
            # Another collector observes the same session, plus a distinct one.
            (private / "remote-pending.json").unlink()
            second = record(number="b", tokens=200)
            with patch.object(remote, "PRIVATE", private), patch.object(remote, "capture", return_value={grown["id"]: grown, second["id"]: second}):
                remote.upload({**settings, "machine_id": "desktop"}, root, sdk)
                remote.pull(root)
            bundle = json.loads((private / "remote-input.json").read_text())
            self.assertEqual(bundle["exact"][0]["codex_tokens"], 1250)
            self.assertEqual(len(bundle["collection"]["collectors"]), 2)
            self.assertEqual(root.collection("usage").document(grown["id"]).get().to_dict()["collectors"], ["desktop", "laptop"])
            # Exercise the actual builder against the atomic bundle; no local
            # logs or exact-daily.json exist here, and unknown models stay unknown.
            source = build.ROOT / "data/pricing.json"
            (Path(directory) / "pricing.json").write_text(source.read_text())
            with patch.object(build, "DATA", Path(directory)), patch.object(build, "PRICING_PATH", Path(directory) / "pricing.json"):
                build.main(remote=True)
            published = json.loads((Path(directory) / "daily-burn.json").read_text())
            row = next(r for r in published if r["date"] == "2026-10-02")
            self.assertEqual(row["codex_tokens"], 1250)
            self.assertEqual(row["cost_usd"]["unpriced_tokens"], 1250)
            self.assertEqual(json.loads((Path(directory) / "meta.json").read_text())["collection_mode"], "firestore")
            before = copy.deepcopy(bundle)
            # A corrupt remote split must not replace the last good bundle.
            invalid = record(number="c")
            invalid["counts"]["models"]["test-model"]["input"] = -1
            root.collection("usage").document(invalid["id"]).set({"record": invalid})
            with patch.object(remote, "PRIVATE", private), self.assertRaises(ValueError):
                remote.pull(root)
            self.assertEqual(json.loads((private / "remote-input.json").read_text()), before)
