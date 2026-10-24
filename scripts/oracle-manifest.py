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
import tempfile
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
        if not (path.is_file() and os.access(path, os.X_OK)):
            continue
        result = subprocess.run(
            [str(path), "-I", "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
            capture_output=True,
            check=False,
            text=True,
        )
        if result.returncode == 0 and tuple(map(int, result.stdout.strip().split("."))) >= (3, 12):
            return path
    return None


if sys.version_info < (3, 12):
    python312 = _python312_or_newer()
    if python312 is None:
        print("oracle manifest generation requires Python 3.12 or newer", file=sys.stderr)
        raise SystemExit(2)
    os.execv(str(python312), [str(python312), "-B", "-I", str(Path(__file__).resolve()), *sys.argv[1:]])


ROOT = Path(__file__).resolve().parent.parent
ORACLE = ROOT / "test" / "oracle" / "claude-swap-v0.28.0"
MANIFEST = ORACLE / "MANIFEST.json"
LICENSE = ROOT / "third_party" / "claude-swap" / "LICENSE"
PINNED_COMMIT = "2b2d71c7aeb49e6bd25393509ceb05dbca7b0e10"
# This anchor is intentionally duplicated in the Node test. Updating a manifest
# alone cannot bless altered vendored bytes.
PINNED_FILES_AGGREGATE_SHA256 = "ca95ba205a093a2a96a52537f7f7a39f365842764cae6fb3e3e9c6895d182b58"


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _git_blob_id(path: Path) -> str:
    content = path.read_bytes()
    return hashlib.sha1(f"blob {len(content)}\0".encode("ascii") + content).hexdigest()


def _files_below(root: Path) -> list[Path]:
    paths = list(root.rglob("*"))
    symlinks = sorted(path for path in paths if path.is_symlink())
    if symlinks:
        raise RuntimeError(f"symlink in vendored tree: {symlinks[0].relative_to(root).as_posix()}")
    return sorted(
        (
            path
            for path in paths
            if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
        ),
        key=lambda path: path.as_posix(),
    )


def _upstream_path(path: Path) -> str:
    if path == LICENSE:
        return "LICENSE"
    relative = path.relative_to(ORACLE).as_posix()
    if relative.startswith(("src/", "tests/")):
        return relative
    raise RuntimeError(f"vendored file has no upstream path: {path.relative_to(ROOT).as_posix()}")


def _git_tree_lines(repository: str) -> list[str]:
    if repository.startswith("-"):
        raise RuntimeError("--verify-upstream must not begin with '-'")

    def ls_tree(repo: Path) -> list[str]:
        result = subprocess.run(
            [
                "git", "-c", "core.fsmonitor=", "-c", "core.sshCommand=", "-C", str(repo),
                "ls-tree", "-r", PINNED_COMMIT, "--",
            ],
            capture_output=True,
            check=True,
            text=True,
        )
        return result.stdout.splitlines()

    local = Path(repository)
    if local.is_dir():
        return ls_tree(local)
    with tempfile.TemporaryDirectory(prefix="qlb-oracle-upstream-") as staging:
        repo = Path(staging) / "upstream"
        subprocess.run(
            [
                "git", "-c", "core.fsmonitor=", "-c", "core.sshCommand=", "clone", "--no-checkout",
                "--", repository, str(repo),
            ],
            check=True,
        )
        return ls_tree(repo)


def _verify_upstream(repository: str, manifest: dict[str, object]) -> None:
    expected = manifest["upstream_tree"]
    if not isinstance(expected, list) or not all(isinstance(line, str) for line in expected):
        raise RuntimeError("manifest upstream_tree is invalid")
    expected_paths = {line.partition("\t")[2] for line in expected}
    actual = [line for line in _git_tree_lines(repository) if line.partition("\t")[2] in expected_paths]
    if actual != expected:
        raise RuntimeError("upstream Git tree differs from manifest blob listing")


def _files_aggregate_sha256(files: dict[str, str]) -> str:
    listing = "".join(f"{path} {digest}\n" for path, digest in sorted(files.items()))
    return hashlib.sha256(listing.encode("utf-8")).hexdigest()


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
    file_hashes = {path.relative_to(ROOT).as_posix(): _sha256(path) for path in sorted(files)}
    git_blob_ids = {path.relative_to(ROOT).as_posix(): _git_blob_id(path) for path in sorted(files)}
    upstream_tree = sorted(
        (
            f"100644 blob {git_blob_ids[path.relative_to(ROOT).as_posix()]}\t{_upstream_path(path)}"
            for path in files
        ),
        key=lambda line: line.partition("\t")[2],
    )
    files_aggregate_sha256 = _files_aggregate_sha256(file_hashes)
    if files_aggregate_sha256 != PINNED_FILES_AGGREGATE_SHA256:
        raise RuntimeError("vendored files differ from the pinned provenance aggregate")
    return {
        "commit": PINNED_COMMIT,
        "files": file_hashes,
        "files_aggregate_sha256": files_aggregate_sha256,
        "git_blob_ids": git_blob_ids,
        "purpose": "Complete claude-swap v0.28.0 source closure and reference material; the cc-locks interop test executes it via python3 -I -B, never QLB at runtime.",
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
        "upstream_tree": upstream_tree,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--check", action="store_true", help="fail if MANIFEST.json differs from the vendored tree")
    modes.add_argument("--verify-upstream", metavar="URL_OR_PATH", help="verify manifest blobs against the pinned upstream Git tree")
    args = parser.parse_args()
    if not sys.flags.isolated:
        parser.error("run this script with Python -I")

    expected = json.dumps(_manifest(), indent=2, sort_keys=True) + "\n"
    if args.check or args.verify_upstream:
        try:
            actual = MANIFEST.read_text(encoding="utf-8")
        except FileNotFoundError:
            actual = ""
        if actual != expected:
            print("oracle manifest differs; run python3 -I scripts/oracle-manifest.py", file=sys.stderr)
            return 1
        if args.verify_upstream:
            _verify_upstream(args.verify_upstream, json.loads(actual))
            print("oracle upstream matches")
            return 0
        print("oracle manifest matches")
        return 0
    MANIFEST.write_text(expected, encoding="utf-8")
    print("oracle manifest written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
