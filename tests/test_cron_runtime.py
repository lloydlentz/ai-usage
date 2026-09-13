"""The hourly refresh runs under cron, whose minimal PATH resolves `python3` to
macOS's /usr/bin/python3 (3.9) -- not the newer Python an interactive shell
finds. These checks keep the pipeline importable there, whichever Python runs
the suite."""
import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def evaluated_annotations(tree):
    """Every annotation Python evaluates when its def or assignment runs."""
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            args = node.args
            for arg in (*args.posonlyargs, *args.args, *args.kwonlyargs, args.vararg, args.kwarg):
                if arg is not None and arg.annotation is not None:
                    yield arg.annotation
            if node.returns is not None:
                yield node.returns
        elif isinstance(node, ast.AnnAssign):
            yield node.annotation


def defers_annotations(tree):
    return any(
        isinstance(node, ast.ImportFrom) and node.module == "__future__"
        and any(alias.name == "annotations" for alias in node.names)
        for node in tree.body
    )


class CronPythonTests(unittest.TestCase):
    def test_union_annotations_are_deferred_for_python_3_9(self):
        # `int | None` in a signature is evaluated when the def runs, and on
        # 3.9 that raises TypeError at import: the 2026-09-13 13:00 refresh
        # died this way. `from __future__ import annotations` defers it.
        for path in sorted([*(ROOT / "scripts").glob("*.py"), *(ROOT / "tests").glob("*.py")]):
            tree = ast.parse(path.read_text())
            unions = sorted({
                annotation.lineno for annotation in evaluated_annotations(tree)
                if any(isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr)
                       for node in ast.walk(annotation))
            })
            with self.subTest(file=path.name):
                self.assertTrue(
                    not unions or defers_annotations(tree),
                    f"{path.name} lines {unions}: X | Y annotations need "
                    f"`from __future__ import annotations` on Python 3.9",
                )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
