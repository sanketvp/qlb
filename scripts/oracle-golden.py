#!/usr/bin/env python3
"""Generate a deterministic, offline behavior oracle for claude-swap 0.28.0.

This script imports only the pinned v0.28.0 source clone after replacing HOME
with an empty temporary directory. It invokes no network, Keychain, credential
store, or CLI APIs; every input below is synthetic.
"""

from __future__ import annotations

import argparse
import dataclasses
import io
import json
import os
import socket
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import Any

# claude-swap 0.28.0 requires Python 3.12. macOS supplies Python 3.9 as
# `python3`, so retain the documented `python3 -I ...` entry point while
# re-executing in the isolated 3.12 interpreter already installed for
# claude-swap. This invokes no claude-swap CLI or package installation.
if sys.version_info < (3, 12):
    PYTHON312 = Path.home() / ".local/share/uv/tools/claude-swap/bin/python"
    if not PYTHON312.is_file():
        raise RuntimeError("claude-swap 0.28.0 golden generation requires Python 3.12")
    os.execv(str(PYTHON312), [str(PYTHON312), "-I", str(Path(__file__).resolve()), *sys.argv[1:]])

ROOT = Path(__file__).resolve().parent.parent
GOLDENS = ROOT / "test" / "oracle" / "goldens"
# This is the read-only clone supplied for the v0.28.0 oracle refresh.
UPSTREAM_REPO = Path(
    os.environ.get(
        "CLAUDE_SWAP_V028_REPO",
        "/private/tmp/claude-501/-Users-sanketpatel-GIT-Personal-sanketvp/"
        "3b005b8d-b97c-4bb5-a726-86eaa04c5eb9/scratchpad/cswap-upstream/repo",
    )
)
PINNED_COMMIT = "2b2d71c7aeb49e6bd25393509ceb05dbca7b0e10"


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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if committed goldens differ")
    args = parser.parse_args()
    if not sys.flags.isolated:
        parser.error("run this script with Python -I")

    if not (UPSTREAM_REPO / ".git").exists():
        parser.error(f"pinned claude-swap v0.28.0 clone is unavailable: {UPSTREAM_REPO}")

    with tempfile.TemporaryDirectory(prefix="qlb-oracle-home-") as temp_home:
        home = Path(temp_home)
        commit = subprocess.run(
            ["git", "-C", str(UPSTREAM_REPO), "rev-parse", f"{PINNED_COMMIT}^{{commit}}"],
            capture_output=True,
            check=True,
            text=True,
        ).stdout.strip()
        if commit != PINNED_COMMIT:
            raise RuntimeError("claude-swap v0.28.0 tag does not match the pinned commit")
        archive = subprocess.run(
            ["git", "-C", str(UPSTREAM_REPO), "archive", "--format=tar", PINNED_COMMIT, "src"],
            capture_output=True,
            check=True,
        ).stdout
        source_root = home / "pinned-source"
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            for member in tar.getmembers():
                destination = source_root / member.name
                if not destination.resolve().is_relative_to(source_root.resolve()):
                    raise RuntimeError("refusing an unsafe path in the claude-swap source archive")
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    source = tar.extractfile(member)
                    if source is None:
                        raise RuntimeError(f"could not read source archive member: {member.name}")
                    destination.write_bytes(source.read())
                else:
                    raise RuntimeError(f"unexpected source archive member: {member.name}")
        upstream_src = source_root / "src"
        # Python -I omits user and environment import paths. Insert this exact
        # tag's source explicitly so this can never use installed claude-swap.
        sys.path.insert(0, str(upstream_src))
        # The source tree is intentionally not installed. Supply only the
        # package metadata needed by claude_swap.__init__ without exposing any
        # installed package to the isolated interpreter.
        metadata = home / "metadata" / "claude_swap-0.28.0.dist-info"
        metadata.mkdir(parents=True)
        (metadata / "METADATA").write_text(
            "Metadata-Version: 2.1\\nName: claude-swap\\nVersion: 0.28.0\\n",
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
        from claude_swap import claude_locks, macos_keychain, oauth, poll_policy, settings
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
