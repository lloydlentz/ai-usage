"""Per-thread tokens: extraction by conversation, and the ledger's thread split."""
import json
import sqlite3
import tempfile
import unittest
from collections import defaultdict
from contextlib import closing, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from ._loader import FIXTURE_HOME, load_script

extract = load_script("extract_exact")
build = load_script("build_daily_burn")

DAY = "2026-09-01"


def entry_tokens(entry):
    """Tokens in a rendered thread-day (models carry their own `tokens`)."""
    return sum(counts["tokens"] for counts in entry["models"].values()) + entry["unattributed"]


def collector_tokens(thread, day):
    """Tokens in an extractor collector day (raw counters, no totals yet)."""
    counts = thread["days"][day]
    return sum(
        value for model in counts["models"].values() for key, value in model.items() if key != "calls"
    ) + counts["unattributed"]


def split(tokens, model="m"):
    return {"models": {model: {"input": tokens, "output": 0, "tokens": tokens}}, "unattributed": 0}


def thread(key, days, tool="claude_code", title=None):
    return {"key": key, "tool": tool, "title": title, "days": days}


class ThreadExtractionTests(unittest.TestCase):
    """The daily counts, keyed by conversation instead of by day alone."""

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.home = Path(folder.name)
        patcher = patch.object(extract, "HOME", self.home)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write(self, relative, entries):
        path = self.home / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(entry) + "\n" for entry in entries))

    @staticmethod
    def call(message_id, timestamp, tokens):
        return {"type": "assistant", "timestamp": timestamp, "requestId": f"req-{message_id}",
                "message": {"id": message_id, "model": "claude-opus-5",
                            "usage": {"input_tokens": tokens, "output_tokens": 0}}}

    def rollout(self, name, session_id, timestamp, total):
        usage = {"input_tokens": total - 10, "cached_input_tokens": 0, "output_tokens": 10, "total_tokens": total}
        self.write(f".codex/sessions/2026/09/01/{name}.jsonl", [
            {"timestamp": timestamp, "type": "session_meta", "payload": {"id": session_id, "cwd": "/Users/demo/app"}},
            {"timestamp": timestamp, "type": "turn_context", "payload": {"model": "gpt-5.6-sol"}},
            {"timestamp": timestamp, "type": "event_msg",
             "payload": {"type": "token_count", "info": {"total_token_usage": usage, "last_token_usage": usage}}},
        ])

    def test_a_claude_session_and_its_subagents_are_one_thread(self):
        project = ".claude/projects/-Users-demo-app"
        self.write(f"{project}/sess-a.jsonl", [self.call("m1", "2026-09-01T15:00:00Z", 10)])
        self.write(f"{project}/sess-a/subagents/agent-1.jsonl", [self.call("m2", "2026-09-02T15:00:00Z", 20)])
        threads = {}
        _, _, projects, _ = extract.extract_claude_code(threads)
        key = extract.thread_key("claude_code", "sess-a")
        self.assertEqual(list(threads), [key])
        self.assertEqual({day: collector_tokens(threads[key], day) for day in threads[key]["days"]},
                         {"2026-09-01": 10, "2026-09-02": 20})
        # A sub-agent transcript belongs to its session's project, not "subagents".
        self.assertEqual(dict(projects["2026-09-02"]), {"-Users-demo-app": 20})

    def test_a_rename_outranks_the_ai_title_and_the_latest_line_wins(self):
        project = ".claude/projects/-Users-demo-app"
        self.write(f"{project}/renamed.jsonl", [
            {"type": "ai-title", "aiTitle": "Auto   named"},
            self.call("m1", "2026-09-01T15:00:00Z", 10),
            {"type": "custom-title", "customTitle": "First name"},
            {"type": "custom-title", "customTitle": "Final\n  name"},
        ])
        self.write(f"{project}/summarized.jsonl", [
            {"type": "ai-title", "aiTitle": "Early summary"},
            {"type": "ai-title", "aiTitle": "Later summary"},
            self.call("m2", "2026-09-01T16:00:00Z", 5),
        ])
        self.write(f"{project}/untitled.jsonl", [self.call("m3", "2026-09-01T17:00:00Z", 1)])
        threads = {}
        extract.extract_claude_code(threads)
        self.assertEqual({key: found["title"] for key, found in threads.items()}, {
            extract.thread_key("claude_code", "renamed"): "Final name",
            extract.thread_key("claude_code", "summarized"): "Later summary",
            extract.thread_key("claude_code", "untitled"): None,
        })

    def test_a_replayed_call_counts_once_across_threads(self):
        # A forked session repeats its parent's calls; each is counted once,
        # so the threads still add up to the day.
        project = ".claude/projects/-Users-demo-app"
        self.write(f"{project}/original.jsonl", [self.call("m1", "2026-09-01T15:00:00Z", 10)])
        self.write(f"{project}/fork.jsonl", [self.call("m1", "2026-09-01T15:00:00Z", 10),
                                             self.call("m2", "2026-09-01T16:00:00Z", 3)])
        threads = {}
        tokens, _, _, _ = extract.extract_claude_code(threads)
        self.assertEqual(tokens[DAY], 13)
        self.assertEqual(sum(collector_tokens(found, DAY) for found in threads.values()), 13)

    def test_codex_titles_come_from_codex_state_and_subagents_fold_into_their_parent(self):
        self.rollout("rollout-parent", "parent-id", "2026-09-01T15:00:00Z", 1000)
        self.rollout("rollout-child", "child-id", "2026-09-01T16:00:00Z", 300)
        self.rollout("rollout-indexed", "indexed-id", "2026-09-01T17:00:00Z", 50)
        self.rollout("rollout-bare", "bare-id", "2026-09-01T18:00:00Z", 7)
        (self.home / ".codex/session_index.jsonl").write_text(
            json.dumps({"id": "indexed-id", "thread_name": "From the index"}) + "\n"
            + json.dumps({"id": "parent-id", "thread_name": "Stale index name"}) + "\n")
        with closing(sqlite3.connect(self.home / ".codex/state_5.sqlite")) as db:
            db.execute("create table threads (id text primary key, name text, title text, source text)")
            db.executemany("insert into threads values (?, ?, ?, ?)", [
                ("parent-id", "Renamed parent", "Auto title", "vscode"),
                ("child-id", None, "Child work",
                 json.dumps({"subagent": {"thread_spawn": {"parent_thread_id": "parent-id"}}})),
            ])
            db.commit()
        threads = {}
        with redirect_stdout(StringIO()):
            tokens, _, _, _ = extract.extract_codex(threads)

        def key(session):
            return extract.thread_key("codex", session)

        self.assertEqual({k: found["title"] for k, found in threads.items()}, {
            key("parent-id"): "Renamed parent", key("indexed-id"): "From the index", key("bare-id"): None,
        })
        self.assertEqual(collector_tokens(threads[key("parent-id")], DAY), 1300)
        self.assertEqual(sum(collector_tokens(found, DAY) for found in threads.values()), tokens[DAY])

    def test_an_unreadable_codex_database_costs_titles_not_tokens(self):
        self.rollout("rollout-a", "a-id", "2026-09-01T15:00:00Z", 100)
        (self.home / ".codex/state_5.sqlite").write_bytes(b"not a database")
        threads = {}
        with redirect_stdout(StringIO()):
            tokens, _, _, _ = extract.extract_codex(threads)
        self.assertEqual(tokens[DAY], 100)
        self.assertEqual([found["title"] for found in threads.values()], [None])


class FixtureThreadTests(unittest.TestCase):
    """End to end on the shared fixture tree."""

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        out = Path(folder.name) / "data"
        for name, value in (("HOME", FIXTURE_HOME), ("OUT_DIR", out), ("PRIVATE_DIR", out / "private")):
            patcher = patch.object(extract, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        with redirect_stdout(StringIO()):
            extract.main()
        self.path = out / "private" / "thread-daily.json"
        self.threads = json.loads(self.path.read_text())
        self.rows = json.loads((out / "exact-daily.json").read_text())

    def test_thread_days_add_up_to_both_tool_columns(self):
        totals = defaultdict(int)
        for found in self.threads:
            for day, entry in found["days"].items():
                totals[(day, found["tool"])] += entry_tokens(entry)
        for row in self.rows:
            for tool, column in build.BREAKDOWN_TOOLS.items():
                with self.subTest(day=row["date"], tool=tool):
                    self.assertEqual(totals.get((row["date"], tool), 0), row[column])

    def test_keys_are_opaque_and_the_file_is_byte_stable(self):
        self.assertTrue(self.threads)
        for found in self.threads:
            self.assertRegex(found["key"], r"^(cc|cx)-[0-9a-f]{12}$")
        before = self.path.read_text()
        with redirect_stdout(StringIO()):
            extract.main()
        self.assertEqual(self.path.read_text(), before)

    def test_the_ledger_accepts_and_prices_the_extracted_split(self):
        rows = [{"date": r["date"], "claude_code_tokens": r["claude_code_tokens"], "codex_tokens": r["codex_tokens"]}
                for r in self.rows]
        merged = build.build_threads(self.threads, [], rows, build.load_pricing())
        build.validate_threads(merged, rows)
        self.assertEqual(sum(day["tokens"] for found in merged for day in found["days"].values()),
                         sum(r["claude_code_tokens"] + r["codex_tokens"] for r in rows))


class ThreadMergeTests(unittest.TestCase):
    """A day's split across threads is frozen whole, one tool at a time."""

    RATES = {"m": {"input": 2.0, "output": 10.0}}

    def merge(self, fresh, captured, column=20):
        rows = [{"date": DAY, "claude_code_tokens": column, "codex_tokens": 0}]
        merged = build.build_threads(fresh, captured, rows, self.RATES)
        build.validate_threads(merged, rows)
        return {found["key"]: found["days"][DAY]["tokens"] for found in merged}

    def test_a_complete_fresh_split_replaces_the_captured_one(self):
        captured = [thread("a", {DAY: split(10)}), thread("b", {DAY: split(10)})]
        fresh = [thread("a", {DAY: split(5)}), thread("b", {DAY: split(15)})]
        self.assertEqual(self.merge(fresh, captured), {"a": 5, "b": 15})

    def test_pruned_logs_keep_the_captured_split_whole(self):
        # Transcript "a" was pruned, and its replayed call now counts under
        # "b". Per-thread maxima would publish a=10 and b=12: 22 tokens in a
        # 20-token column.
        captured = [thread("a", {DAY: split(10)}), thread("b", {DAY: split(10)})]
        fresh = [thread("b", {DAY: split(12)})]
        self.assertEqual(self.merge(fresh, captured), {"a": 10, "b": 10})

    def test_a_partial_split_stands_when_nothing_better_was_captured(self):
        self.assertEqual(self.merge([thread("a", {DAY: split(5)})], [], column=8), {"a": 5})

    def test_tools_are_chosen_independently(self):
        rows = [{"date": DAY, "claude_code_tokens": 20, "codex_tokens": 7}]
        captured = [thread("a", {DAY: split(20)}), thread("x", {DAY: split(7)}, tool="codex")]
        fresh = [thread("a", {DAY: split(12)}), thread("x", {DAY: split(7)}, tool="codex", title="Fresh")]
        merged = build.build_threads(fresh, captured, rows, self.RATES)
        self.assertEqual({found["key"]: (found["days"][DAY]["tokens"], found["title"]) for found in merged},
                         {"a": (20, None), "x": (7, "Fresh")})

    def test_a_split_larger_than_its_column_stops_the_build(self):
        with self.assertRaisesRegex(ValueError, "exceeds its column"):
            self.merge([], [thread("a", {DAY: split(30)})])

    def test_a_fresh_title_wins_and_a_captured_one_survives(self):
        rows = [{"date": DAY, "claude_code_tokens": 20, "codex_tokens": 0}]
        merged = build.build_threads(
            [thread("a", {DAY: split(5)}), thread("b", {DAY: split(5)}, title="New")],
            [thread("a", {DAY: split(5)}, title="Kept"), thread("b", {DAY: split(5)}, title="Old")],
            rows, self.RATES)
        self.assertEqual({found["key"]: found["title"] for found in merged}, {"a": "Kept", "b": "New"})

    def test_thread_days_are_priced_and_an_unknown_model_is_unpriced_not_free(self):
        rows = [{"date": DAY, "claude_code_tokens": 3_000_000, "codex_tokens": 0}]
        merged = {found["key"]: found["days"][DAY] for found in build.build_threads(
            [thread("known", {DAY: split(1_000_000)}), thread("mystery", {DAY: split(2_000_000, model="nope")})],
            [], rows, self.RATES)}
        self.assertEqual((merged["known"]["cost_usd"], merged["known"]["unpriced_tokens"]), (2.0, 0))
        self.assertEqual((merged["mystery"]["cost_usd"], merged["mystery"]["unpriced_tokens"]), (0.0, 2_000_000))

    def test_output_is_sorted_and_empty_thread_days_are_dropped(self):
        rows = [{"date": DAY, "claude_code_tokens": 5, "codex_tokens": 0}]
        merged = build.build_threads([thread("z", {DAY: split(5)}), thread("a", {DAY: split(0)})], [], rows, self.RATES)
        self.assertEqual([found["key"] for found in merged], ["z"])

    def test_validation_rejects_a_day_that_does_not_add_up(self):
        rows = [{"date": DAY, "claude_code_tokens": 5, "codex_tokens": 0}]
        merged = build.build_threads([thread("a", {DAY: split(5)})], [], rows, self.RATES)
        merged[0]["days"][DAY]["tokens"] = 6
        with self.assertRaisesRegex(ValueError, "do not reconcile"):
            build.validate_threads(merged, rows)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
