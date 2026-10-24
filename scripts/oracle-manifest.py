#!/usr/bin/env python3
"""Generate and verify the claude-swap v0.28.0 oracle manifest without importing it."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def _python312_or_newer() -> Path | None:
    candidates: list[str] = []
    try:
        found = subprocess.run(
            ["uv", "python", "find", "3.12"], capture_output=True, check=False, text=True
        ).stdout.strip()
        if found:
            candidates.append(found)
    except FileNotFoundError:
        pass
    python312 = shutil.which("python3.12")
    if python312:
        candidates.append(python312)
    for candidate in candidates:
        path = Path(candidate)
        if path.is_file() and os.access(path, os.X_OK):
            return path
    return None


if sys.version_info < (3, 12):
    python312 = _python312_or_newer()
    if python312 is None:
        print("oracle manifest generation requires Python 3.12 or newer", file=sys.stderr)
        raise SystemExit(2)
    os.execv(str(python312), [str(python312), "-I", str(Path(__file__).resolve()), *sys.argv[1:]])


ROOT = Path(__file__).resolve().parent.parent
ORACLE = ROOT / "test" / "oracle" / "claude-swap-v0.28.0"
MANIFEST = ORACLE / "MANIFEST.json"
LICENSE = ROOT / "third_party" / "claude-swap" / "LICENSE"
PINNED_COMMIT = "2b2d71c7aeb49e6bd25393509ceb05dbca7b0e10"


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _files_below(root: Path) -> list[Path]:
    return sorted(
        (
            path
            for path in root.rglob("*")
            if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
        ),
        key=lambda path: path.as_posix(),
    )


def _test_def_count(path: Path) -> int:
    if path.suffix != ".py":
        return 0
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    return sum(
        isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_")
        for node in ast.walk(tree)
    )


def _manifest() -> dict[str, object]:
    files = [path for path in _files_below(ORACLE) if path != MANIFEST]
    files.append(LICENSE)
    test_root = ORACLE / "tests"
    switcher_tree = ast.parse(
        (test_root / "test_switcher.py").read_text(encoding="utf-8"),
        filename=str(test_root / "test_switcher.py"),
    )
    return {
        "commit": PINNED_COMMIT,
        "files": {path.relative_to(ROOT).as_posix(): _sha256(path) for path in sorted(files)},
        "purpose": "Complete claude-swap v0.28.0 source closure and reference material; it is not executed by Node or QLB.",
        "tag": "v0.28.0",
        "test_def_counts": {
            path.relative_to(ORACLE).as_posix(): _test_def_count(path) for path in _files_below(test_root)
        },
        "test_switcher_top_level_test_classes": [
            node.name
            for node in switcher_tree.body
            if isinstance(node, ast.ClassDef) and node.name.startswith("Test")
        ],
        "upstream": "https://github.com/realiti4/claude-swap",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if MANIFEST.json differs from the vendored tree")
    args = parser.parse_args()
    if not sys.flags.isolated:
        parser.error("run this script with Python -I")

    expected = json.dumps(_manifest(), indent=2, sort_keys=True) + "\n"
    if args.check:
        try:
            actual = MANIFEST.read_text(encoding="utf-8")
        except FileNotFoundError:
            actual = ""
        if actual != expected:
            print("oracle manifest differs; run python3 -I scripts/oracle-manifest.py", file=sys.stderr)
            return 1
        print("oracle manifest matches")
        return 0
    MANIFEST.write_text(expected, encoding="utf-8")
    print("oracle manifest written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
