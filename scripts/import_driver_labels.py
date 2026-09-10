#!/usr/bin/env python3
"""Import an explorer export: only known dates and preset categories may publish."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATEGORIES = {"shipping", "research", "review", "video", "admin", "unlabeled"}

def validate_labels(payload, known_dates):
    if not isinstance(payload, dict) or set(payload) != {"version", "labels"} or payload["version"] != 1:
        raise ValueError("Expected a version 1 label export")
    labels = payload["labels"]
    if not isinstance(labels, dict) or any(day not in known_dates or not isinstance(label, str) or label not in CATEGORIES for day, label in labels.items()):
        raise ValueError("Labels must use existing ledger dates and preset categories")
    return labels

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export", type=Path)
    args = parser.parse_args()
    dates = {r["date"] for r in json.loads((ROOT / "data/daily-burn.json").read_text())}
    labels = validate_labels(json.loads(args.export.read_text()), dates)
    target = ROOT / "scripts/driver-labels.json"
    current = json.loads(target.read_text()) if target.exists() else {}
    current.update(labels)
    target.write_text(json.dumps(dict(sorted(current.items())), indent=2) + "\n")
    print(f"Imported {len(labels)} labels. Run python3 scripts/build_daily_burn.py to regenerate the dashboard.")

if __name__ == "__main__":
    main()
