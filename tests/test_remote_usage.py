"""Remote accounting: duplicates, migration, pruning, and failed-upload retries."""
from __future__ import annotations

import copy
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tests._loader import load_script, FIXTURE_HOME

remote = load_script("remote_usage")
extract = load_script("extract_exact")
build = load_script("build_daily_burn")


def record(tool="codex", number="a", tokens=100, day="2026-10-02"):
    prefix = "cx" if tool == "codex" else "cc"
    counts = {"input": tokens, "cache_read": 0, "output": 0, "tokens": tokens}
    if tool == "claude_code":
        counts["calls"] = 1
    return {"id": prefix + "-" + number * 64, "tool": tool, "date": day,
            "first_at": day + "T18:00:00+00:00", "thread": prefix + "-" + number * 12,
            "title": "Example", "counts": {"models": {"test-model": counts}, "unattributed": 0}}


class Snapshot:
    def __init__(self, data):
        self.data = copy.deepcopy(data)
        self.exists = data is not None

    def to_dict(self):
        return copy.deepcopy(self.data)


class Store:
    def __init__(self):
        self.values = {}
        self.fail = None

    def transaction(self):
        return self

    def collection(self, name):
        return Collection(self, name)

    def set(self, ref, value):
        ref.set(value)


class Collection:
    def __init__(self, store, path):
        self.store, self.path = store, path
        self.id = path.split("/")[-1]

    def document(self, key):
        return Ref(self.store, self.path + "/" + key)

    def stream(self):
        return [Snapshot(value) for path, value in sorted(self.store.values.items())
                if path.startswith(self.path + "/") and path.count("/") == self.path.count("/") + 1]


class Ref:
    def __init__(self, store, path):
        self._client, self.path = store, path
        self.parent = Collection(store, path.rsplit("/", 1)[0])

    def get(self, transaction=None):
        return Snapshot(self._client.values.get(self.path))

    def set(self, value):
        if self._client.fail and self._client.fail in self.path:
            raise ConnectionError("Simulated outage")
        self._client.values[self.path] = copy.deepcopy(value)

    def collection(self, name):
        return Collection(self._client, self.path + "/" + name)


class SDK:
    @staticmethod
    def transactional(fn):
        return fn


class PublicReportTests(unittest.TestCase):
    def test_publisher_switch_and_failed_generation_preserve_current_report(self):
        store = Store()
        root = store.collection("ai_usage").document("ledger")
        root.set({"primary": "old-mac", "publisher": "mac-m1-pro"})
        settings = {"machine_id": "mac-m1-pro", "namespace": "ai_usage"}
        with self.assertRaisesRegex(ValueError, "designated"):
            remote.check_publisher({"machine_id": "old-mac"}, root)
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / "scripts").symlink_to(remote.ROOT / "scripts", target_is_directory=True)
            shutil.copytree(remote.ROOT / "data", base / "data", ignore=shutil.ignore_patterns("private", "exact-daily.json"))
            meta_path = base / "data/meta.json"
            meta = json.loads(meta_path.read_text())
            meta["private_path"] = "/secret/local/project"
            meta_path.write_text(json.dumps(meta))
            with patch.object(remote, "ROOT", base):
                remote.publish(settings, root)
                report = store.collection("public_reports").document("ai_usage")
                good = report.get().to_dict()
                chunks = report.collection("versions").document(good["version"]).collection("chunks").stream()
                payload = json.loads("".join(c.to_dict()["payload"] for c in chunks))
                self.assertNotIn("private_path", payload["meta"])
                self.assertEqual(payload["rows"], json.loads((base / "data/daily-burn.json").read_text()))
                rows_path = base / "data/daily-burn.json"
                rows = json.loads(rows_path.read_text())
                rows[-1]["driver"] = "x" * 300_000
                rows_path.write_text(json.dumps(rows))
                store.fail = "/chunks/1"
                with self.assertRaises(ConnectionError):
                    remote.publish(settings, root)
                self.assertEqual(report.get().to_dict(), good)


class RemoteAccountingTests(unittest.TestCase):
    def test_mirrored_sessions_and_pruned_snapshots_count_once(self):
        first = record(tokens=100)
        current = remote.choose(first, record(tokens=150))
        current = remote.choose(current, record(tokens=80))
        rows, threads = remote.aggregate([], [], [{"record": current}])
        self.assertEqual(rows[0]["codex_tokens"], 150)
        self.assertEqual(threads[0]["days"]["2026-10-02"]["tokens"], 150)

    def test_forked_claude_request_keeps_original_thread(self):
        first = record("claude_code")
        replay = copy.deepcopy(first)
        replay["thread"] = "cc-" + "b" * 12
        self.assertEqual(remote.choose(first, replay)["thread"], first["thread"])
        replay["counts"]["models"]["test-model"].update(input=101, tokens=101)
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            remote.choose(first, replay)

    def test_redistributing_codex_counts_requires_audit(self):
        old = record()
        fresh = record(tokens=150)
        fresh["counts"]["models"]["test-model"].update(input=50, output=100)
        with self.assertRaisesRegex(ValueError, "redistributes"):
            remote.choose(old, fresh)

    def test_baseline_plus_only_distinct_growth(self):
        baseline = [{"date": "2026-10-02", "codex_tokens": 1000,
                     "claude_code_tokens": 0, "claude_code_calls": 0}]
        first = record(tokens=100)
        current = record(tokens=150)
        rows, threads = remote.aggregate(baseline, [], [
            {"record": current, "baseline": first["counts"]},
            {"record": record(number="b", tokens=200)},
        ])
        self.assertEqual(rows[0]["codex_tokens"], 1250)
        self.assertEqual(rows[0]["breakdown"]["codex"]["unattributed"], 1000)
        self.assertEqual(sum(t["days"]["2026-10-02"]["tokens"] for t in threads), 250)
        priced = build.build_row("2026-10-02", rows[0], None, rates={})
        build.validate_rows([priced])
        self.assertEqual(priced["cost_usd"]["unpriced_tokens"], 1250)

    def test_baseline_threads_keep_measurements_and_drop_prices(self):
        first = record()
        baseline = [{"date": first["date"], "codex_tokens": 100,
                     "claude_code_tokens": 0, "claude_code_calls": 0,
                     "breakdown": {"codex": first["counts"]}}]
        threads = [{"key": first["thread"], "title": "Example", "tool": "codex", "days": {
            first["date"]: {**first["counts"], "tokens": 100, "cost_usd": 999, "unpriced_tokens": 0}}}]
        rows, fresh = remote.aggregate(baseline, threads, [{"record": record(tokens=150), "baseline": first["counts"]}])
        self.assertEqual(rows[0]["codex_tokens"], 150)
        self.assertEqual(fresh[0]["days"][first["date"]]["tokens"], 150)
        self.assertNotIn("cost_usd", fresh[0]["days"][first["date"]])

    def test_privacy_and_invalid_counters_rejected(self):
        invalid = record()
        invalid["cwd"] = "/private/project"
        with self.assertRaisesRegex(ValueError, "Unexpected"):
            remote.validate_record(invalid)
        invalid = record()
        invalid["counts"]["models"]["test-model"]["input"] = -1
        with self.assertRaises(ValueError):
            remote.validate_record(invalid)
        invalid = record()
        invalid["date"] = "2026-10-01"
        with self.assertRaisesRegex(ValueError, "Chicago"):
            remote.validate_record(invalid)

    def test_firestore_map_order_does_not_reformat_published_threads(self):
        first = record("claude_code")
        model = first["counts"]["models"]["test-model"]
        first["counts"]["models"]["test-model"] = dict(sorted(model.items()))
        rows, threads = remote.aggregate([], [], [{"record": first}])
        published = build.build_threads(threads, [], rows, {})
        self.assertEqual(list(published[0]["days"][first["date"]]["models"]["test-model"]),
                         ["calls", "input", "cache_read", "output", "tokens"])

    def test_extractors_emit_scrubbed_stable_identities(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            shutil.copytree(FIXTURE_HOME, home, dirs_exist_ok=True)
            # Existing local fixtures deliberately contain unidentifiable calls.
            # Those must fail upload, then test the identifiable subset.
            with patch.object(extract, "HOME", home), self.assertRaisesRegex(ValueError, "lacks"):
                extract.extract_claude_code({}, [])
            for path in (home / ".claude/projects").rglob("*.jsonl"):
                lines = []
                for line in path.read_text().splitlines():
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    message = entry.get("message") or {}
                    if message.get("usage") and not message.get("id") and not entry.get("requestId"):
                        continue
                    lines.append(line)
                path.write_text("\n".join(lines))
            for folder in ("sessions", "archived_sessions"):
                for path in (home / ".codex" / folder).rglob("*.jsonl"):
                    entry = {"type": "session_meta", "payload": {"id": path.stem, "cwd": "/fixture"}}
                    path.write_text(json.dumps(entry) + "\n" + path.read_text())
            records = []
            threads = {}
            with patch.object(extract, "HOME", home):
                extract.extract_claude_code(threads, records)
                extract.extract_codex(threads, records)
        self.assertTrue(records)
        for item in records:
            item["title"] = None
            remote.validate_record(item)
        self.assertTrue(any(r["tool"] == "codex" for r in records))
        self.assertTrue(any(r["tool"] == "claude_code" for r in records))

    def test_failed_upload_retries_after_source_logs_disappear(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(remote, "PRIVATE", Path(directory)):
            private = Path(directory)
            (private / "collection.json").write_text(json.dumps({"sources_available": {"codex": True, "claude_code": True}}))
            store = Store()
            root = Ref(store, "test/ledger")
            root.set({"schema": 1, "cutover": "2026-10-02T12:00:00+00:00", "primary": "primary"})
            settings = {"project_id": "test-project", "machine_id": "remote"}
            value = record()
            store.fail = "/usage/"
            with patch.object(remote, "capture", return_value={value["id"]: value}), self.assertRaises(ConnectionError):
                remote.upload(settings, root, SDK)
            self.assertEqual(len(json.loads((private / "remote-pending.json").read_text())["records"]), 1)
            self.assertFalse(root.collection("collectors").document("remote").get().exists)
            store.fail = None
            with patch.object(remote, "capture", return_value={}):
                remote.upload(settings, root, SDK)
                remote.upload(settings, root, SDK)
            self.assertEqual(len(root.collection("usage").stream()), 1)
            self.assertEqual(json.loads((private / "remote-pending.json").read_text())["records"], {})
            remote.pull(root)
            bundle = json.loads((private / "remote-input.json").read_text())
            self.assertEqual(bundle["exact"][0]["codex_tokens"], 100)
            self.assertEqual(bundle["collection"]["collectors"][0]["machine_id"], "remote")

    def test_unknown_pre_migration_usage_cannot_double_count_history(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(remote, "PRIVATE", Path(directory)):
            private = Path(directory)
            (private / "collection.json").write_text(json.dumps({"sources_available": {"codex": True}}))
            store = Store()
            root = Ref(store, "test/ledger")
            root.set({"schema": 1, "cutover": "2026-10-02T19:00:00+00:00", "primary": "primary"})
            value = record()
            with patch.object(remote, "capture", return_value={value["id"]: value}):
                remote.upload({"project_id": "test-project", "machine_id": "remote"}, root, SDK)
            self.assertEqual(len(root.collection("usage").stream()), 0)
            self.assertEqual(root.collection("collectors").document("remote").get().to_dict()["skipped_historical_records"], 1)

    def test_cloud_import_preserves_observed_freshness(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(remote, "PRIVATE", Path(directory)):
            store = Store()
            root = Ref(store, "test/ledger")
            root.set({"schema": 1, "cutover": "2026-10-02T12:00:00+00:00", "primary": "primary"})
            # This timestamp intentionally remains old even if imported later.
            exported = {"records": [record()], "collected_at": "2026-10-02T18:00:00+00:00",
                        "sources_available": {"codex": True}}
            with patch.object(remote, "capture", side_effect=AssertionError("must not read local logs")):
                remote.upload({"project_id": "test-project", "machine_id": "cloud"}, root, SDK, exported)
            remote.pull(root)
            bundle = json.loads((Path(directory) / "remote-input.json").read_text())
            self.assertEqual(bundle["collection"]["collected_at"], exported["collected_at"])
            self.assertEqual(bundle["collection"]["sources_available"], {"codex": True})

    def test_queue_cannot_follow_a_configuration_change(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(remote, "PRIVATE", Path(directory)):
            store = Store()
            root = Ref(store, "test/ledger")
            root.set({"schema": 1, "cutover": "2026-10-02T12:00:00+00:00", "primary": "primary"})
            (Path(directory) / "remote-pending.json").write_text(json.dumps({"records": {}, "destination": {
                "project_id": "different-project", "namespace": "test", "database": "(default)", "machine_id": "remote"}}))
            with patch.object(remote, "capture", side_effect=AssertionError("must retain queue")), self.assertRaisesRegex(ValueError, "another destination"):
                remote.upload({"project_id": "test-project", "machine_id": "remote"}, root, SDK)


if __name__ == "__main__":
    unittest.main()
