"""QLB route plugin for Hermes.

The QLB proxy (``~/GIT/qlb``) sits on loopback and forwards Anthropic Messages requests with a
Claude *subscription* OAuth bearer chosen by headroom. Hermes decides whether a route is an OAuth
route in ``agent.anthropic_credentials.anthropic_route_is_oauth`` — true only for
``api.anthropic.com`` or the ``anthropic`` provider. A named custom provider pointed at
``http://127.0.0.1:<port>`` therefore looks third-party, so Hermes skips the OAuth payload identity
(Claude Code system prefix, product-name sanitizing, tool-name aliases) and Anthropic's classifier
answers ``400 "Third-party apps now draw from your extra usage"``.

This plugin extends the predicate: a base_url whose host is loopback and whose port is the QLB
proxy port (read from ``~/.qlb/proxy.json``, else ``QLB_PROXY_PORT``, else 47391) is an OAuth
route. Nothing else changes; every other host keeps Hermes's own decision.

Provider-plugin dirs are imported by ``providers/__init__.py`` which documents that user plugins
may "monkey-patch or replace any built-in profile without editing the repo".

Upgrade contract (checked by ``qlb doctor`` → ``hermes:plugin``):
  * ``STATUS_FILE`` is rewritten on every load with ``{ok, reason, hermes_seam, plugin_version}``.
    Hermes upgrades that rename/move the seam make ``ok=false`` — detected, not silent.
  * The predicate's signature is validated before patching; on mismatch the plugin refuses to patch
    (Hermes keeps its own behaviour) and records why.
"""

from __future__ import annotations

import inspect
import json
import logging
import os
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

PLUGIN_VERSION = "1.1.0"
_DEFAULT_PORT = 47391
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
STATUS_FILE = Path(os.environ.get("QLB_HERMES_PLUGIN_STATUS", os.path.expanduser("~/.qlb/hermes-plugin.json")))

# The exact seam this plugin depends on. If Hermes moves it, ``_locate_seam`` returns None.
_SEAM_MODULE = "agent.anthropic_credentials"
_SEAM_FUNC = "anthropic_route_is_oauth"
_SEAM_PARAMS = ("base_url", "credential", "provider")


def _qlb_proxy_port() -> int:
    info = Path(os.environ.get("QLB_PROXY_INFO", os.path.expanduser("~/.qlb/proxy.json")))
    try:
        port = int(json.loads(info.read_text(encoding="utf-8")).get("port") or 0)
        if port > 0:
            return port
    except Exception:
        pass
    try:
        return int(os.environ.get("QLB_PROXY_PORT") or _DEFAULT_PORT)
    except ValueError:
        return _DEFAULT_PORT


def is_qlb_route(base_url: Any) -> bool:
    text = str(base_url or "").strip()
    if not text:
        return False
    u = urlparse(text if "://" in text else f"http://{text}")
    host = (u.hostname or "").lower()
    return host in _LOOPBACK_HOSTS and u.port == _qlb_proxy_port()


def _write_status(ok: bool, reason: str, **extra: Any) -> None:
    payload = {
        "ok": ok,
        "reason": reason,
        "plugin_version": PLUGIN_VERSION,
        "hermes_seam": f"{_SEAM_MODULE}.{_SEAM_FUNC}",
        "proxy_port": _qlb_proxy_port(),
        "written_at": int(time.time()),
        **extra,
    }
    try:
        STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = STATUS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, STATUS_FILE)
    except Exception as exc:  # status is advisory; never break Hermes
        logger.debug("qlb plugin: could not write status file: %s", exc)


def _locate_seam():
    """Return (module, original_fn) or raise with a precise reason."""
    import importlib

    mod = importlib.import_module(_SEAM_MODULE)
    fn = getattr(mod, _SEAM_FUNC, None)
    if fn is None:
        raise LookupError(f"{_SEAM_MODULE}.{_SEAM_FUNC} no longer exists")
    params = tuple(inspect.signature(fn).parameters)
    if params != _SEAM_PARAMS:
        raise LookupError(f"{_SEAM_FUNC} signature changed: {params} (expected {_SEAM_PARAMS})")
    return mod, fn


def _install() -> None:
    try:
        mod, original = _locate_seam()
    except Exception as exc:
        # Hermes moved the seam. Do NOT guess: leave Hermes alone, record it so qlb doctor fails.
        _write_status(False, f"seam missing: {exc}")
        logger.warning(
            "qlb plugin: Hermes seam %s.%s unavailable (%s) — QLB Anthropic route will get "
            "'third-party' treatment until the plugin is updated. Run: qlb doctor",
            _SEAM_MODULE, _SEAM_FUNC, exc)
        return
    if getattr(original, "_qlb_patched", False):
        _write_status(True, "already patched")
        return

    def anthropic_route_is_oauth(base_url: Any, credential: Any, *, provider: str | None = None) -> bool:
        if is_qlb_route(base_url):
            return True
        return original(base_url, credential, provider=provider)

    anthropic_route_is_oauth._qlb_patched = True  # type: ignore[attr-defined]
    anthropic_route_is_oauth._qlb_original = original  # type: ignore[attr-defined]
    anthropic_route_is_oauth.__doc__ = original.__doc__
    anthropic_route_is_oauth.__wrapped__ = original  # type: ignore[attr-defined]
    setattr(mod, _SEAM_FUNC, anthropic_route_is_oauth)
    _write_status(True, "patched")
    logger.debug("qlb plugin: %s extended for loopback port %s", _SEAM_FUNC, _qlb_proxy_port())


try:
    _install()
except Exception as exc:  # never break provider discovery
    _write_status(False, f"install error: {exc}")
    logger.warning("qlb plugin: could not extend %s: %s", _SEAM_FUNC, exc)
