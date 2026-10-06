#!/usr/bin/env python3
"""Private Firestore usage ledger. Optional; the local pipeline needs no SDK.

Commands: initialize (primary only), collect (any machine), pull (publisher).
Configuration and the durable retry queue live in data/private/.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = ROOT / "data/private"
TYPES = ("input", "cache_write_5m", "cache_write_1h", "cache_read", "output")
COLUMNS = {"claude_code": "claude_code_tokens", "codex": "codex_tokens"}


def acquire_lock(handle):
    """Non-blocking exclusive lock on an open file; fcntl has no Windows build.

    The OS releases either lock even after a killed collector, unlike a lock directory.
    """
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        raise RuntimeError("Another remote collector operation is running") from None


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True), encoding="utf-8")
    temporary.replace(path)


def total(counts):
    return sum(m["tokens"] for m in counts["models"].values()) + counts["unattributed"]


def leaves(counts):
    out = {("", "unattributed"): counts["unattributed"]}
    for model, values in counts["models"].items():
        for field in (*TYPES, "calls"):
            out[(model, field)] = values.get(field, 0)
    return out


def validate_record(record):
    # Strict allowlist: no transcript, cwd, raw provider ID, or price is uploaded.
    if set(record) != {"id", "tool", "date", "first_at", "thread", "title", "counts"}:
        raise ValueError("Unexpected usage record fields")
    tool = record["tool"]
    prefix = {"claude_code": "cc", "codex": "cx"}.get(tool)
    if not prefix or not re.fullmatch(prefix + r"-[0-9a-f]{64}", record["id"]):
        raise ValueError("Invalid usage identity")
    if not re.fullmatch(prefix + r"-[0-9a-f]{12}", record["thread"]):
        raise ValueError("Invalid thread identity")
    when = datetime.fromisoformat(record["first_at"].replace("Z", "+00:00"))
    if when.tzinfo is None or when.astimezone(ZoneInfo("America/Chicago")).date().isoformat() != record["date"]:
        raise ValueError("Usage date must be an America/Chicago day")
    if record["title"] is not None and (not isinstance(record["title"], str) or len(record["title"]) > 120):
        raise ValueError("Invalid thread title")
    counts = record["counts"]
    if set(counts) != {"models", "unattributed"} or not isinstance(counts["models"], dict):
        raise ValueError("Invalid usage breakdown")
    if type(counts["unattributed"]) is not int or counts["unattributed"] < 0:
        raise ValueError("Invalid unattributed tokens")
    allowed = set(TYPES) | {"tokens", "calls"}
    for model, values in counts["models"].items():
        if not isinstance(model, str) or not model or len(model) > 200:
            raise ValueError("Invalid model")
        if set(values) - allowed or "tokens" not in values:
            raise ValueError("Unexpected model fields")
        if any(type(n) is not int or n < 0 for n in values.values()):
            raise ValueError("Token counts must be nonnegative integers")
        if values["tokens"] != sum(values.get(t, 0) for t in TYPES):
            raise ValueError("Model tokens do not reconcile")
        if tool == "codex" and any(values.get(t, 0) for t in ("calls", "cache_write_5m", "cache_write_1h")):
            raise ValueError("Unsupported Codex counters")
    if tool == "claude_code" and (counts["unattributed"] or sum(m.get("calls", 0) for m in counts["models"].values()) != 1):
        raise ValueError("Claude records must represent one request")


def choose(old, fresh):
    """Keep a whole snapshot; independent leaf maxima can invent tokens."""
    validate_record(fresh)
    if old is None:
        return copy.deepcopy(fresh)
    validate_record(old)
    if any(old[k] != fresh[k] for k in ("id", "tool", "date")):
        raise ValueError("Usage identity collision")
    a, b = leaves(old["counts"]), leaves(fresh["counts"])
    keys = a.keys() | b.keys()
    if old["tool"] == "claude_code":
        if a != b:
            raise ValueError("Conflicting copies of a Claude request")
        # Thread ownership stays stable even if a fork survives log pruning.
        selected = copy.deepcopy(old)
    elif all(b.get(k, 0) >= a.get(k, 0) for k in keys):
        selected = copy.deepcopy(fresh)
    elif all(b.get(k, 0) <= a.get(k, 0) for k in keys):
        selected = copy.deepcopy(old)
    else:
        raise ValueError("Codex snapshot redistributes captured tokens; audit required")
    selected["first_at"] = min((old["first_at"], fresh["first_at"]), key=datetime.fromisoformat)
    selected["title"] = fresh["title"] or old["title"]
    return selected


def difference(counts, baseline):
    if not baseline:
        return copy.deepcopy(counts)
    a, b = leaves(counts), leaves(baseline)
    if any(a.get(k, 0) < v for k, v in b.items()):
        raise ValueError("Snapshot fell below migration baseline")
    models = {}
    for model, values in counts["models"].items():
        entry = {field: values.get(field, 0) - baseline["models"].get(model, {}).get(field, 0)
                 for field in values if field != "tokens"}
        entry["tokens"] = sum(entry.get(t, 0) for t in TYPES)
        if entry["tokens"] or entry.get("calls"):
            models[model] = entry
    return {"models": models, "unattributed": counts["unattributed"] - baseline["unattributed"]}


def add_counts(target, source):
    target["unattributed"] += source["unattributed"]
    for model, values in source["models"].items():
        entry = target["models"].setdefault(model, {})
        for field, value in values.items():
            entry[field] = entry.get(field, 0) + value


def aggregate(baseline_rows, baseline_threads, documents):
    """Frozen historical totals plus only post-baseline distinct measurements."""
    rows = {r["date"]: {k: copy.deepcopy(v) for k, v in r.items()
                         if k in {"date", *COLUMNS.values(), "claude_code_calls", "breakdown"}}
            for r in baseline_rows}
    threads = {t["key"]: {"key": t["key"], "tool": t["tool"], "title": t["title"],
                          "days": {day: {k: copy.deepcopy(value) for k, value in counts.items()
                                         if k in {"models", "unattributed"}}
                                   for day, counts in t["days"].items()}}
               for t in baseline_threads}
    # Published thread days also contain totals and prices; keep only measurements.
    for thread in threads.values():
        for counts in thread["days"].values():
            for entry in counts["models"].values():
                for field in list(entry):
                    if field not in {*TYPES, "calls", "tokens"}:
                        del entry[field]
    for doc in documents:
        record = doc["record"]
        validate_record(record)
        counts = difference(record["counts"], doc.get("baseline"))
        tool, day = record["tool"], record["date"]
        row = rows.setdefault(day, {"date": day, "codex_tokens": 0, "claude_code_tokens": 0,
                                    "claude_code_calls": 0})
        row[COLUMNS[tool]] = row.get(COLUMNS[tool], 0) + total(counts)
        if tool == "claude_code":
            row["claude_code_calls"] = row.get("claude_code_calls", 0) + sum(m.get("calls", 0) for m in counts["models"].values())
        # Legacy measurements with no split remain explicitly unpriced.
        breakdown = row.setdefault("breakdown", {})
        if tool not in breakdown:
            breakdown[tool] = {"models": {}, "unattributed": row[COLUMNS[tool]] - total(counts)}
        add_counts(breakdown[tool], counts)
        if total(counts) or any(m.get("calls") for m in counts["models"].values()):
            thread = threads.setdefault(record["thread"], {"key": record["thread"], "tool": tool,
                                                            "title": record["title"], "days": {}})
            thread["title"] = record["title"] or thread["title"]
            add_counts(thread["days"].setdefault(day, {"models": {}, "unattributed": 0}), counts)
    # build_threads expects a per-day total alongside the model split.
    for thread in threads.values():
        for counts in thread["days"].values():
            counts["tokens"] = total(counts)
    return [rows[d] for d in sorted(rows)], [threads[k] for k in sorted(threads)]


def config():
    path = PRIVATE / "remote-config.json"
    if not path.exists():
        raise ValueError("Create data/private/remote-config.json; see REMOTE_USAGE.md")
    value = json.loads(path.read_text(encoding="utf-8"))
    for key in ("project_id", "machine_id"):
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", value.get(key, "")):
            raise ValueError("Invalid " + key)
    namespace = value.get("namespace", "ai_usage")
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", namespace):
        raise ValueError("Invalid namespace")
    return value, namespace


def connect(settings, namespace):
    try:
        from google.cloud import firestore
    except ImportError:
        raise RuntimeError("Install requirements-remote.txt in a Python 3.10+ virtual environment") from None
    credentials = None
    if not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        import google.auth
        # ADC can carry an unrelated old quota project. Charge API quota to
        # the explicitly selected ledger project, never that old default.
        credentials, _ = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"],
            quota_project_id=settings["project_id"],
        )
    client = firestore.Client(project=settings["project_id"], credentials=credentials,
                              database=settings.get("database", "(default)"))
    return firestore, client.collection(namespace).document("ledger")


def capture(since=None):
    import extract_exact
    records = []
    extract_exact.main(records, record_since=since)
    unique = {}
    for record in records:
        unique[record["id"]] = choose(unique.get(record["id"]), record)
    return unique


def initialize(settings, root, sdk):
    """Stage an immutable migration locally; publish readiness only at the end."""
    draft_path = PRIVATE / "remote-migration.json"
    if root.get().exists:
        raise ValueError("Ledger already initialized or initializing; use collect/pull")
    if draft_path.exists():
        draft = json.loads(draft_path.read_text(encoding="utf-8"))
        if draft["project_id"] != settings["project_id"] or draft["machine_id"] != settings["machine_id"] or draft["namespace"] != root.parent.id or draft["database"] != settings.get("database", "(default)"):
            raise ValueError("Migration draft belongs to another project/machine")
    else:
        migration_day = datetime.now(timezone.utc).astimezone(ZoneInfo("America/Chicago")).date().isoformat()
        records = capture(since=migration_day)
        import build_daily_burn
        build_daily_burn.main()
        rows = json.loads((ROOT / "data/daily-burn.json").read_text(encoding="utf-8"))
        threads = json.loads((ROOT / "data/threads.json").read_text(encoding="utf-8"))
        cutover = datetime.now(timezone.utc).isoformat()
        today = datetime.fromisoformat(cutover).astimezone(ZoneInfo("America/Chicago")).date().isoformat()
        by_day, _ = aggregate([], [], [{"record": r} for r in records.values()])
        current = next((r for r in rows if r["date"] == today), {})
        captured = next((r for r in by_day if r["date"] == today), {})
        for column in (*COLUMNS.values(), "claude_code_calls"):
            if current.get(column, 0) != captured.get(column, 0):
                raise ValueError("Today's frozen ledger differs from available logs; migrate on a complete collection day")
        draft = {"project_id": settings["project_id"], "machine_id": settings["machine_id"],
                 "namespace": root.parent.id, "database": settings.get("database", "(default)"),
                 "cutover": cutover, "rows": rows, "threads": threads, "records": records}
        write_json(draft_path, draft)
    # create() prevents competing initialization from silently overwriting history.
    # Identical documents allow a failed upload to resume from its private draft.
    def create_once(ref, value):
        from google.api_core.exceptions import AlreadyExists
        try:
            ref.create(value)
        except AlreadyExists:
            if ref.get().to_dict() != value:
                raise ValueError("Conflicting migration document; use a dedicated namespace") from None
    for row in draft["rows"]:
        create_once(root.collection("baseline_days").document(row["date"]), row)
    for thread in draft["threads"]:
        create_once(root.collection("baseline_threads").document(thread["key"]), thread)
    for key, record in draft["records"].items():
        create_once(root.collection("usage").document(key), {"record": record, "baseline": record["counts"],
                                                             "collectors": [settings["machine_id"]]})
    create_once(root, {"schema": 1, "cutover": draft["cutover"], "primary": settings["machine_id"]})
    print("Migration initialized; run collect and pull before enabling the scheduled remote refresh")


def upload(settings, root, sdk, exported=None):
    state = root.get().to_dict()
    if not state or state.get("schema") != 1:
        raise ValueError("Initialize the ledger on the primary machine first")
    cutover = datetime.fromisoformat(state["cutover"])
    cutover_day = cutover.astimezone(ZoneInfo("America/Chicago")).date().isoformat()
    queue_path = PRIVATE / "remote-pending.json"
    # Save before networking. A failed run retains all measurements for retry,
    # including requests whose source logs disappear before the next scan.
    queue = json.loads(queue_path.read_text(encoding="utf-8")) if queue_path.exists() else {"records": {}}
    destination = {"project_id": settings["project_id"], "namespace": root.parent.id,
                   "database": settings.get("database", "(default)"), "machine_id": settings["machine_id"]}
    if queue.get("destination", destination) != destination:
        raise ValueError("Pending uploads belong to another destination or machine")
    if exported is None:
        captured = capture(since=cutover_day)
        scan = json.loads((PRIVATE / "collection.json").read_text(encoding="utf-8"))
    else:
        # Cloud adapters supply the same measured record contract. No provider
        # integration or token estimate is silently fabricated here.
        if set(exported) != {"records", "collected_at", "sources_available"}:
            raise ValueError("Unexpected cloud export fields")
        scan = {"collected_at": exported["collected_at"], "sources_available": exported["sources_available"]}
        observed = datetime.fromisoformat(scan["collected_at"].replace("Z", "+00:00"))
        if observed.tzinfo is None or observed > datetime.now(timezone.utc):
            raise ValueError("Cloud collection timestamp must be an observed instant")
        scan["collected_at"] = observed.isoformat()
        captured = {}
        for record in exported["records"]:
            validate_record(record)
            if datetime.fromisoformat(record["first_at"]) > observed:
                raise ValueError("Cloud usage is newer than its collection timestamp")
            if record["date"] < cutover_day:
                continue
            captured[record["id"]] = choose(captured.get(record["id"]), record)
    if set(scan["sources_available"]) - COLUMNS.keys() or any(type(v) is not bool for v in scan["sources_available"].values()):
        raise ValueError("Invalid collector source availability")
    for key, record in captured.items():
        queue["records"][key] = choose(queue["records"].get(key), record)
    queue.update({"destination": destination, "collected_at": scan.get("collected_at", datetime.now(timezone.utc).isoformat()),
                  "sources_available": scan["sources_available"]})
    write_json(queue_path, queue)

    @sdk.transactional
    def put(transaction, ref, record):
        doc = ref.get(transaction=transaction).to_dict()
        # Historical unknown identities may already be in the frozen ledger.
        # Never guess whether they are additional usage.
        if doc is None and datetime.fromisoformat(record["first_at"]) < cutover:
            return False
        if doc is not None and record["date"] < cutover_day:
            return False
        selected = choose(doc["record"] if doc else None, record)
        value = dict(doc or {})
        value["record"] = selected
        value["collectors"] = sorted(set(value.get("collectors", [])) | {settings["machine_id"]})
        if value != doc:
            transaction.set(ref, value)
        return True

    skipped = 0
    for key, record in sorted(queue["records"].items()):
        if not put(root._client.transaction(), root.collection("usage").document(key), record):
            skipped += 1
    # A machine's heartbeat moves only when the entire upload succeeds.
    root.collection("collectors").document(settings["machine_id"]).set({
        "machine_id": settings["machine_id"], "collected_at": queue["collected_at"],
        "sources_available": queue["sources_available"],
        "skipped_historical_records": skipped,
    })
    write_json(queue_path, {"destination": destination, "records": {}})
    print(f"Usage uploaded; {skipped} pre-migration records excluded from historical backfill")


def pull(root):
    state = root.get().to_dict()
    if not state or state.get("schema") != 1:
        raise ValueError("Remote ledger is not initialized")
    # Read heartbeats first: an upload completing during the scan cannot make
    # the metadata claim a newer collection than the records we actually read.
    collectors = sorted([d.to_dict() for d in root.collection("collectors").stream()], key=lambda c: c["machine_id"])
    rows, threads = aggregate(
        [d.to_dict() for d in root.collection("baseline_days").stream()],
        [d.to_dict() for d in root.collection("baseline_threads").stream()],
        [d.to_dict() for d in root.collection("usage").stream()],
    )
    if not collectors:
        raise ValueError("No successful remote collectors; run collect first")
    collection = {"collected_at": min((c["collected_at"] for c in collectors), key=datetime.fromisoformat),
                  "sources_available": {tool: all(c["sources_available"][tool] for c in collectors
                                                  if tool in c["sources_available"])
                                        for tool in COLUMNS
                                        if any(tool in c["sources_available"] for c in collectors)},
                  "collectors": collectors, "mode": "firestore"}
    # One atomic bundle prevents the builder from mixing a new total with old threads.
    write_json(PRIVATE / "remote-input.json", {"exact": rows, "threads": threads, "collection": collection})
    print(f"Pulled {len(rows)} days from {len(collectors)} collectors")


def check_publisher(settings, root):
    state = root.get().to_dict() or {}
    if state.get("publisher", state.get("primary")) != settings["machine_id"]:
        raise ValueError("This machine is not the designated dashboard publisher")


def publish(settings, root):
    """Publish only the validated dashboard files, switching generations last.

    Chunks are UTF-8-safe JSON strings below Firestore's 1 MiB document limit.
    A failed upload cannot expose a partial report or replace the last good one.
    Browser rules permit reads here, never on the private measurement ledger.
    """
    check_publisher(settings, root)
    spec = importlib.util.spec_from_file_location("public_build", ROOT / "scripts/build_daily_burn.py")
    build = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build)
    data = ROOT / "data"
    rows = json.loads((data / "daily-burn.json").read_text(encoding="utf-8"))
    threads = json.loads((data / "threads.json").read_text(encoding="utf-8"))
    meta = json.loads((data / "meta.json").read_text(encoding="utf-8"))
    pricing = json.loads((data / "pricing.json").read_text(encoding="utf-8"))
    build.validate_rows(rows)
    build.validate_threads(threads, rows)
    if meta.get("collection_mode") != "firestore":
        raise ValueError("Public report requires a Firestore build")
    bundle = {"schema": 1, "rows": rows, "threads": threads, "pricing": pricing,
              "meta": {key: meta[key] for key in ("refreshed_at", "collected_at", "sources_available", "cost", "collection_mode", "collectors") if key in meta}}
    # ensure_ascii keeps each character one byte even for non-ASCII thread titles.
    payload = json.dumps(bundle, separators=(",", ":"), sort_keys=True, ensure_ascii=True)
    version = hashlib.sha256(payload.encode()).hexdigest()
    report = root._client.collection("public_reports").document(settings.get("namespace", "ai_usage"))
    current = report.get().to_dict()
    if current and current.get("version") == version:
        print("Public dashboard already current")
        return
    chunks = [payload[i:i + 250_000] for i in range(0, len(payload), 250_000)]
    generation = report.collection("versions").document(version)
    for index, chunk in enumerate(chunks):
        generation.collection("chunks").document(str(index)).set({"payload": chunk})
    previous = ([{"version": current["version"], "chunks": current["chunks"]}] + current.get("previous", [])) if current else []
    previous = [item for item in previous if item["version"] != version]
    check_publisher(settings, root)
    report.set({"schema": 1, "version": version, "chunks": len(chunks),
                "refreshed_at": meta["refreshed_at"], "publisher": settings["machine_id"], "previous": previous[:24]})
    # Retain 24 older generations so in-flight readers have ample time to finish.
    # Cleanup failure cannot invalidate a successfully switched public report.
    for old in previous[24:]:
        try:
            for index in range(old["chunks"]):
                report.collection("versions").document(old["version"]).collection("chunks").document(str(index)).delete()
        except Exception as error:
            print(f"Old public snapshot cleanup deferred: {type(error).__name__}")
    print(f"Published dashboard {version[:12]} ({len(chunks)} chunks); no GitHub deployment needed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("initialize", "collect", "pull", "check-publisher", "publish"))
    parser.add_argument("--input", type=Path, help="For collect: normalized measured usage from a cloud adapter, instead of local logs")
    args = parser.parse_args()
    if args.input and args.command != "collect":
        parser.error("--input is only supported with collect")
    settings, namespace = config()
    sdk, root = connect(settings, namespace)
    PRIVATE.mkdir(parents=True, exist_ok=True)
    with (PRIVATE / "remote-collector.lock").open("w") as lock:
        acquire_lock(lock)
        if args.command == "initialize":
            initialize(settings, root, sdk)
        elif args.command == "collect":
            upload(settings, root, sdk, json.loads(args.input.read_text(encoding="utf-8")) if args.input else None)
        elif args.command == "check-publisher":
            check_publisher(settings, root)
        elif args.command == "publish":
            publish(settings, root)
        else:
            pull(root)


if __name__ == "__main__":
    main()
