"""Import helpers for the pipeline scripts.

`scripts/` is a plain directory of executables, not an importable package, so
the test suite loads each script by file path. Both scripts do all of their
file I/O inside functions, so importing them has no side effects.

Neither script takes injectable paths; instead they read module-level
constants (`extract_exact.HOME`, `extract_exact.OUT_DIR`,
`build_daily_burn.DATA`, `build_daily_burn.RANGE_START`) at call time. Tests
therefore point those constants at fixture/temp directories rather than
touching the real logs, which are gitignored, machine-specific and pruned.
"""

import importlib.util
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
FIXTURE_HOME = FIXTURES_DIR / "home"


def load_script(name: str):
    """Import scripts/<name>.py as a module object."""
    if name in sys.modules:
        return sys.modules[name]
    path = SCRIPTS_DIR / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module
