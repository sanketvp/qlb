#!/usr/bin/env python3
"""Generate a deterministic, offline behavior oracle for claude-swap 0.28.0.

Normal checks import only the vendored upstream modules after replacing HOME
with an empty temporary directory. Regeneration is deliberately explicit and
requires a separately supplied upstream Git repository. This invokes no
network, Keychain, credential store, or CLI APIs; every input below is synthetic.
"""

from __future__ import annotations

import argparse
import ast
import dataclasses
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

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


# claude-swap 0.28.0 requires Python 3.12. Keep the documented `python3 -I`
# entry point while finding a general-purpose interpreter rather than relying
# on an installed claude-swap tool environment.
if sys.version_info < (3, 12):
    python312 = _python312_or_newer()
    if python312 is None:
        print("claude-swap 0.28.0 golden generation requires Python 3.12 or newer", file=sys.stderr)
        raise SystemExit(2)
    os.execv(str(python312), [str(python312), "-B", "-I", str(Path(__file__).resolve()), *sys.argv[1:]])

ROOT = Path(__file__).resolve().parent.parent
GOLDENS = ROOT / "test" / "oracle" / "goldens"
VENDORED_SRC = ROOT / "test" / "oracle" / "claude-swap-v0.28.0" / "src"
PINNED_COMMIT = "2b2d71c7aeb49e6bd25393509ceb05dbca7b0e10"
SOURCE_FILES = (
    "__init__.py", "__main__.py", "app_bundle.py", "appearance.py", "autoswitch.py",
    "cache.py", "claude_locks.py", "cli.py", "credentials.py", "exceptions.py", "fsutil.py",
    "json_output.py", "launch_agent.py", "lines.py", "locking.py", "logging_config.py",
    "macos_keychain.py", "mappings.py", "menubar.py", "migrations.py", "models.py", "oauth.py",
    "pace.py", "paths.py", "poll_policy.py", "printer.py", "process_detection.py", "session.py",
    "settings.py", "snapshot_source.py", "switcher.py", "transfer.py", "tui/__init__.py",
    "tui/app.py", "tui/autoview.py", "tui/cswap.tcss", "tui/dashboard.py", "tui/data.py",
    "tui/modals.py", "tui/theme.py", "tui/widgets.py", "update_check.py", "usage_store.py",
)


def _blocked_socket(*_args: Any, **_kwargs: Any) -> None:
    raise RuntimeError("oracle golden generation must not use the network")


def _json(value: object) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def _credential(refresh: str | None, access: str = "fake-access") -> str:
    oauth: dict[str, str] = {"accessToken": access}
    if refresh is not None:
        oauth["refreshToken"] = refresh
    return json.dumps({"claudeAiOauth": oauth}, sort_keys=True, separators=(",", ":"))


def _usage(pct: float, *, reset: str | None = None, scoped: float | None = None) -> dict:
    window: dict[str, object] = {"pct": pct}
    if reset is not None:
        window["resets_at"] = reset
    usage: dict[str, object] = {"five_hour": dict(window), "seven_day": dict(window)}
    if scoped is not None:
        usage["scoped"] = [{"name": "Fable", "pct": scoped}]
    return usage


def _round_plan(plan: tuple[float, float]) -> dict[str, float]:
    return {"next_poll_at": round(plan[0], 6), "interval_s": round(plan[1], 6)}


def _source_from_git(repository: str, staging: Path) -> Path:
    """Materialize the complete pinned package from a maintainer-supplied repo."""
    if repository.startswith("-"):
        raise RuntimeError("--from-git must not begin with '-'")
    # Always clone into staging so subsequent Git reads do not use a supplied
    # local repository's configuration.
    repo = staging / "upstream"
    subprocess.run(
        ["git", "clone", "--depth", "1", "--branch", "v0.28.0", "--", repository, str(repo)],
        check=True,
    )
    tag_commit = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "v0.28.0^{commit}"],
        capture_output=True,
        check=True,
        text=True,
    ).stdout.strip()
    if tag_commit != PINNED_COMMIT:
        raise RuntimeError(
            f"claude-swap tag v0.28.0 resolves to {tag_commit}, not pinned commit {PINNED_COMMIT}"
        )

    source_root = staging / "src"
    package = source_root / "claude_swap"
    package.mkdir(parents=True)
    for name in SOURCE_FILES:
        content = subprocess.run(
            ["git", "-C", str(repo), "show", f"{PINNED_COMMIT}:src/claude_swap/{name}"],
            capture_output=True,
            check=True,
        ).stdout
        destination = package / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
    return source_root


def _module_exists(source_root: Path, module: str) -> bool:
    relative = Path(*module.split("."))
    return (source_root / relative).with_suffix(".py").is_file() or (source_root / relative / "__init__.py").is_file()


def _validate_source_root(source_root: Path) -> None:
    package = source_root / "claude_swap"
    missing = [name for name in SOURCE_FILES if not (package / name).is_file()]
    if missing:
        raise RuntimeError(f"vendored claude-swap v0.28.0 source is incomplete: {', '.join(missing)}")
    unexpected = sorted(
        path.relative_to(package).as_posix()
        for path in package.rglob("*")
        if path.is_file()
        and "__pycache__" not in path.parts
        and path.suffix != ".pyc"
        and path.relative_to(package).as_posix() not in SOURCE_FILES
    )
    if unexpected:
        raise RuntimeError(f"vendored claude-swap v0.28.0 source has unexpected files: {', '.join(unexpected)}")

    unresolved: list[str] = []
    for path in package.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            modules: list[str] = []
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names if alias.name.startswith("claude_swap.")]
            elif isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("claude_swap"):
                modules = [node.module]
                modules.extend(
                    candidate
                    for alias in node.names
                    if _module_exists(source_root, candidate := f"{node.module}.{alias.name}")
                )
            for module in modules:
                if not _module_exists(source_root, module):
                    unresolved.append(f"{path.relative_to(source_root)} imports {module}")
    if unresolved:
        raise RuntimeError("vendored claude-swap imports are unresolved: " + "; ".join(sorted(unresolved)))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check", action="store_true", help="fail if committed goldens differ")
    modes.add_argument("--regen", action="store_true", help="rewrite goldens from the pinned upstream source")
    parser.add_argument("--from-git", metavar="URL_OR_PATH", help="upstream Git repository for --regen")
    args = parser.parse_args()
    if not sys.flags.isolated:
        parser.error("run this script with Python -I")
    # Vendored oracle inputs are immutable; do not create machine-specific bytecode beside them.
    sys.dont_write_bytecode = True
    if args.regen != bool(args.from_git):
        parser.error("--regen requires --from-git URL_OR_PATH, and --from-git requires --regen")

    with tempfile.TemporaryDirectory(prefix="qlb-oracle-home-") as temp_home:
        home = Path(temp_home)
        upstream_src = _source_from_git(args.from_git, home) if args.regen else VENDORED_SRC
        _validate_source_root(upstream_src)
        # Python -I omits user and environment import paths. Insert this exact
        # tag's source explicitly so this can never use an installed claude-swap.
        sys.path.insert(0, str(upstream_src))
        # The source tree is intentionally not installed. Supply only the
        # package metadata needed by claude_swap.__init__ without exposing any
        # installed package to the isolated interpreter.
        metadata = home / "metadata" / "claude_swap-0.28.0.dist-info"
        metadata.mkdir(parents=True)
        (metadata / "METADATA").write_text(
            "Metadata-Version: 2.1\nName: claude-swap\nVersion: 0.28.0\n",
            encoding="utf-8",
        )
        sys.path.insert(1, str(metadata.parent))
        os.environ.update(
            {
                "HOME": str(home),
                "USERPROFILE": str(home),
                "XDG_DATA_HOME": str(home / "xdg-data"),
                "USER": "oracle-user",
            }
        )
        for name in ("CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"):
            os.environ.pop(name, None)

        # Imports occur only after process isolation. The functions called below
        # are deterministic transformations/path derivations with fake inputs.
        from claude_swap import __version__, claude_locks, macos_keychain, oauth, poll_policy, settings
        if __version__ != "0.28.0":
            raise RuntimeError(f"vendored claude-swap version is {__version__!r}, expected '0.28.0'")
        from claude_swap.session import keychain_service_name

        if not Path(claude_locks.__file__).resolve().is_relative_to(upstream_src.resolve()):
            raise RuntimeError("oracle imported claude-swap outside the pinned v0.28.0 source")
        from claude_swap.switcher import ClaudeAccountSwitcher

        # Imports load urllib/ssl, so install the network refusal only after
        # import time and before invoking any package function.
        socket.socket = _blocked_socket  # type: ignore[assignment]

        fingerprints = {
            "empty": oauth.credential_fingerprint(""),
            "invalid_json": oauth.credential_fingerprint("not-json"),
            "oauth_refresh": oauth.credential_fingerprint(_credential("fake-refresh")),
            "oauth_rotated_access": oauth.credential_fingerprint(
                _credential("fake-refresh", "rotated-fake-access")
            ),
            "oauth_without_refresh": oauth.credential_fingerprint(_credential(None)),
            "fake_api_key": oauth.credential_fingerprint("fake-api-key"),
        }

        constants = {
            name: getattr(poll_policy, name)
            for name in (
                "SERVE_TTL_S", "MIN_INTERVAL_S", "URGENT_INTERVAL_S",
                "ACTIVE_MAX_INTERVAL_S", "CANDIDATE_DEFAULT_INTERVAL_S",
                "CANDIDATE_MAX_INTERVAL_S", "EXHAUSTED_INTERVAL_S",
                "MOVEMENT_DELTA_PCT", "JITTER_FRAC", "EDGE_BACKOFF_S",
                "POST_429_MIN_INTERVAL_S", "RECENT_429_WINDOW_S",
                "POST_429_BACKOFF_MULT", "POST_429_MAX_INTERVAL_S",
                "ESCALATION_MARGIN_PCT", "RESET_SLACK_S",
            )
        }
        grid = [
            ("unknown_active", dict(prev_interval_s=None, prev_usage=None, new_usage=None, is_active=True, threshold=90.0, models=(), recent_429=False, now=1000.0, rng=lambda: 0.5)),
            ("unknown_candidate", dict(prev_interval_s=None, prev_usage=None, new_usage=None, is_active=False, threshold=90.0, models=(), recent_429=False, now=1000.0, rng=lambda: 0.5)),
            ("stable_active", dict(prev_interval_s=180.0, prev_usage=_usage(40), new_usage=_usage(40), is_active=True, threshold=90.0, models=(), recent_429=False, now=1000.0, rng=lambda: 0.5)),
            ("stable_candidate", dict(prev_interval_s=300.0, prev_usage=_usage(40), new_usage=_usage(40), is_active=False, threshold=90.0, models=(), recent_429=False, now=1000.0, rng=lambda: 0.5)),
            ("moving_active", dict(prev_interval_s=300.0, prev_usage=_usage(40), new_usage=_usage(50), is_active=True, threshold=90.0, models=(), recent_429=False, now=1000.0, rng=lambda: 0.5)),
            ("urgent_active", dict(prev_interval_s=300.0, prev_usage=_usage(70), new_usage=_usage(80), is_active=True, threshold=90.0, models=(), recent_429=False, now=1000.0, rng=lambda: 0.5)),
            ("recent_429", dict(prev_interval_s=600.0, prev_usage=_usage(40), new_usage=_usage(50), is_active=True, threshold=90.0, models=(), recent_429=True, now=1000.0, rng=lambda: 0.5)),
            ("exhausted_reset_cap", dict(prev_interval_s=180.0, prev_usage=_usage(99), new_usage=_usage(100, reset="1970-01-01T00:18:00+00:00"), is_active=False, threshold=90.0, models=(), recent_429=False, now=1000.0, rng=lambda: 0.5)),
            ("scoped_model_binds", dict(prev_interval_s=300.0, prev_usage=_usage(30, scoped=60), new_usage=_usage(30, scoped=80), is_active=True, threshold=90.0, models=("Fable",), recent_429=False, now=1000.0, rng=lambda: 0.0)),
        ]
        plans = {name: _round_plan(poll_policy.plan_after_fetch(**kwargs)) for name, kwargs in grid}

        keychain_services = {
            path: keychain_service_name(path)
            for path in (
                "/oracle-home/.claude",
                "/oracle-home/.claude/",
                "/oracle-home/./.claude",
                "/tmp/café",
                "/tmp/cafe\u0301",
                "relative/config",
            )
        }
        lock_paths = {
            "oauth_refresh": str(claude_locks.oauth_refresh_lock_dir()).replace(str(home), "$HOME"),
            "legacy_credentials": str(claude_locks.credentials_lock_dir()).replace(str(home), "$HOME"),
            "global_config": str(claude_locks.config_lock_dir()).replace(str(home), "$HOME"),
        }
        locks = {
            "constants": {
                "credentials_staleness_s": claude_locks.CREDENTIALS_STALENESS_S,
                "config_staleness_s": claude_locks.CONFIG_STALENESS_S,
                "touch_interval_s": claude_locks.TOUCH_INTERVAL_S,
                "default_timeout_s": claude_locks.DEFAULT_TIMEOUT_S,
                "contention_wait_s": {"minimum": 0.25, "maximum": 0.5},
            },
            "paths": lock_paths,
            "credential_acquisition_order": ["oauth_refresh", "legacy_credentials"],
        }

        class FakeSwitcher:
            def __init__(self, backups: dict[tuple[str, str], str | None], verdicts: dict[object, bool] | None = None):
                self.backups = backups
                self._probe_verdicts = verdicts or {}

            def _read_account_credentials(self, account: str, email: str) -> str | None:
                return self.backups.get((account, email))

            def _lineage_key(self, *parts: str) -> tuple[str, ...]:
                return parts

            def _find_account_slot(self, data: dict, email: str, org: str) -> str | None:
                for slot, account in data.get("accounts", {}).items():
                    if account.get("email") == email and (account.get("organizationUuid", "") or "") == org:
                        return slot
                return None

        own = {"accounts": {"1": {"email": "one@example.test", "uuid": "uuid-one", "organizationUuid": "org-one"}, "2": {"email": "two@example.test", "uuid": "uuid-two", "organizationUuid": "org-two"}}}
        live = _credential("lineage-live")
        own_creds = _credential("lineage-live", "old-fake-access")
        foreign_creds = _credential("other-lineage")

        def classify(fake: FakeSwitcher, original: str, provenance: dict, data: dict = own) -> list[str | None]:
            result = ClaudeAccountSwitcher._classify_outgoing_credential(
                fake, "1", "one@example.test", original, provenance, data
            )
            return [result[0], result[1]]

        classifier = {
            "own_bytes": classify(FakeSwitcher({("1", "one@example.test"): live}), live, {}),
            "own_family": classify(FakeSwitcher({("1", "one@example.test"): own_creds}), live, {}),
            "wiped": classify(FakeSwitcher({}), _credential(None, ""), {}),
            "own_rotated": classify(FakeSwitcher({}), live, {"live": live, "resolved": {"uuid": "uuid-one", "email": "one@example.test", "organizationUuid": "org-one"}}),
            "foreign": classify(FakeSwitcher({("2", "two@example.test"): foreign_creds}), live, {"live": live, "resolved": {"uuid": "uuid-two", "email": "two@example.test", "organizationUuid": "org-two"}}),
            "foreign_synced": classify(FakeSwitcher({("2", "two@example.test"): live}), live, {"live": live, "resolved": {"uuid": "uuid-two", "email": "two@example.test", "organizationUuid": "org-two"}}),
            "alien": classify(FakeSwitcher({}), live, {"live": live, "resolved": {"uuid": "uuid-alien", "email": "alien@example.test", "organizationUuid": "org-alien"}}),
            "unresolved": classify(FakeSwitcher({}), live, {"live": "different", "resolved": None}),
        }
        lineage_key = ("1", "one@example.test", oauth.credential_fingerprint(live) or "")
        classifier["known_foreign"] = classify(FakeSwitcher({}, {lineage_key: False}), live, {})

        goldens: dict[str, object] = {
            "credential_fingerprint.json": fingerprints,
            "poll_policy.json": {"constants": constants, "plans": plans},
            "keychain.json": {
                "service_names": keychain_services,
                "account_name_with_fake_user": macos_keychain.keychain_account_name(),
            },
            "claude_locks.json": locks,
            "settings_defaults.json": {
                "schema_version": settings.SETTINGS_SCHEMA_VERSION,
                "filename": settings.SETTINGS_FILENAME,
                "autoswitch": dataclasses.asdict(settings.AutoSwitchSettings()),
                "ui": dataclasses.asdict(settings.UiSettings()),
            },
            "switcher_classify_outgoing_credential.json": {
                "method": "ClaudeAccountSwitcher._classify_outgoing_credential",
                "driven_with": "unbound method and in-memory fake switcher only",
                "cases": classifier,
            },
        }

    mismatches: list[str] = []
    for name, value in goldens.items():
        path = GOLDENS / name
        expected = _json(value)
        if args.check:
            try:
                actual = path.read_text(encoding="utf-8")
            except FileNotFoundError:
                mismatches.append(f"missing {path.relative_to(ROOT)}")
            else:
                if actual != expected:
                    mismatches.append(f"mismatch {path.relative_to(ROOT)}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(expected, encoding="utf-8")
    if mismatches:
        print("oracle goldens differ:", *mismatches, sep="\n", file=sys.stderr)
        return 1
    print("oracle goldens match" if args.check else "oracle goldens written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
