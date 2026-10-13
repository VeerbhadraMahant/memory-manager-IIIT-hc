"""Secret loading and leak-hardening, written for confidential-compute deployments.

What a trusted execution environment (AMD SEV-SNP / Intel TDX confidential VMs, AWS
Nitro Enclaves, Azure/GCP confidential containers, dstack/Phala, Gramine/SGX) changes
about key handling, and what this module does about it:

* **Secrets arrive at runtime, never in the image.** A TEE's guarantee is that memory is
  encrypted and the operator cannot read it; baking a key into an image or a `.env` file
  on the host disk defeats that. Every secret can therefore come from a file
  (`NAME_FILE=/run/secrets/name`, the Docker/Kubernetes/attestation-agent convention,
  normally a tmpfs), from the environment, or from a secrets directory — in that order.
* **Secrets are `SecretStr`.** They print as `**********` in reprs, tracebacks and
  `model_dump()`. The raw value is only ever unwrapped at the point it is put on the
  wire (an Authorization header).
* **Secrets are scrubbed from the process environment** after loading, so a child
  process, a debug endpoint or a crash dump of `os.environ` cannot hand them out.
* **Log lines and error text are redacted** (`RedactingFilter`, `scrub`) — upstream
  HTTP libraries echo URLs and headers in exceptions, and an exception message is the
  usual way a key ends up in a log aggregator or in a 502 body.
* **TEE presence is detected and reported** (`tee_status`), and `REQUIRE_TEE=true`
  refuses to boot outside one.

What it deliberately does *not* claim: it cannot verify an attestation quote (that needs
the relying party — your KMS or secrets broker — to check the quote *before* releasing
the secret; this app consumes the result of that release). Detection here is "a
confidential-computing guest device is present", which is a deployment sanity check,
not proof. And prompts still leave the enclave toward the LLM provider unless
`LLM_BASE_URL` points at an inference endpoint that is itself inside a TEE.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path

# Environment variables that hold secret material. Anything in this tuple is loadable
# via NAME_FILE, scrubbed from os.environ after load, and redacted from logs.
SECRET_ENV_NAMES: tuple[str, ...] = (
    "DATABASE_URL",
    "LLM_API_KEY",
    "GROQ_API_KEY",
    "GEMINI_API_KEY",
    "SESSION_SECRET",
    "SUPABASE_JWT_SECRET",
    "SUPABASE_SERVICE_ROLE_KEY",
)

SECRETS_DIR_ENV = "SECRETS_DIR"
DEFAULT_SECRETS_DIR = Path("/run/secrets")


def _read_file(path: str) -> str:
    return Path(path).read_text(encoding="utf-8").strip()


def load_secret_overrides(environ: dict[str, str] | None = None) -> dict[str, str]:
    """Resolve file-backed secrets into `{field_name: value}` init kwargs.

    Precedence (highest first): `NAME_FILE` → `$SECRETS_DIR/name` (lowercase) → the plain
    environment variable, which pydantic-settings reads itself. Returned as kwargs
    rather than written back into `os.environ`, so file-provided secrets never touch
    the environment at all.
    """
    env = os.environ if environ is None else environ
    secrets_dir = Path(env.get(SECRETS_DIR_ENV) or DEFAULT_SECRETS_DIR)
    out: dict[str, str] = {}
    for name in SECRET_ENV_NAMES:
        field = name.lower()
        file_ref = env.get(f"{name}_FILE")
        if file_ref:
            try:
                value = _read_file(file_ref)
            except OSError as e:
                # Name the variable, never the content. Failing here is right: a
                # configured-but-unreadable secret file silently falling back to "no
                # key" would surface later as a confusing 502.
                raise RuntimeError(f"{name}_FILE={file_ref!r} is unreadable: {e.strerror}") from e
            if value:
                out[field] = value
            continue
        candidate = secrets_dir / field
        if name not in env and candidate.is_file():
            value = _read_file(str(candidate))
            if value:
                out[field] = value
    return out


def scrub_environment() -> list[str]:
    """Remove secret variables (and their *_FILE pointers) from `os.environ`.

    Called after Settings() has been built. Returns the names removed, for the startup
    log. This narrows exposure to child processes and in-process introspection; it does
    not erase the initial environ block the kernel exposes at /proc/<pid>/environ,
    which is why file-based secrets are the recommended path inside a TEE.
    """
    removed = []
    for name in SECRET_ENV_NAMES:
        for var in (name, f"{name}_FILE"):
            if var in os.environ:
                del os.environ[var]
                removed.append(var)
    return removed


# --------------------------------------------------------------------- redaction

# Provider key shapes seen in this app's stack, plus generic bearer/query-key forms.
_PATTERNS = [
    re.compile(r"sk-or-v1-[A-Za-z0-9_-]{16,}"),  # OpenRouter
    re.compile(r"gsk_[A-Za-z0-9]{16,}"),  # Groq
    re.compile(r"AIza[0-9A-Za-z_-]{20,}"),  # Google API key
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{12,}"),
    re.compile(r"(?i)([?&](?:key|api_key|apikey|token|access_token)=)[^&\s'\"]+"),
    re.compile(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*"),  # JWTs
    re.compile(r"(?i)(postgres(?:ql)?://[^:/\s]+:)[^@\s]+(@)"),  # password in DSN
]

_known_values: set[str] = set()


def register_secret_values(values: list[str]) -> None:
    """Remember the exact secret strings so they are redacted wherever they appear,
    including shapes the regexes above do not know about."""
    for v in values:
        if v and len(v) >= 8:
            _known_values.add(v)


def scrub(text: str) -> str:
    """Redact anything key-shaped, and every registered secret, from `text`."""
    for v in _known_values:
        text = text.replace(v, "[redacted]")
    for p in _PATTERNS:
        if p.groups == 0:
            text = p.sub("[redacted]", text)
        elif p.groups == 1:
            text = p.sub(r"\1[redacted]", text)
        else:
            text = p.sub(r"\1[redacted]\2", text)
    return text


class RedactingFilter(logging.Filter):
    """Scrub secrets from every record, including formatted args and exception text."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            record.msg = scrub(record.getMessage())
            record.args = ()
            if record.exc_info and record.exc_info[1] is not None:
                record.exc_text = scrub(logging.Formatter().formatException(record.exc_info))
                record.exc_info = None
        except Exception:  # noqa: S110 — a logging filter must never raise
            pass
        return True


# --------------------------------------------------------------------- TEE detection

# Guest-side device nodes / sockets that exist only inside the matching environment.
_TEE_PROBES: tuple[tuple[str, str], ...] = (
    ("/dev/sev-guest", "amd-sev-snp"),
    ("/dev/tdx_guest", "intel-tdx"),
    ("/dev/tdx-guest", "intel-tdx"),
    ("/dev/nsm", "aws-nitro-enclave"),
    ("/dev/attestation", "gramine-sgx"),
    ("/var/run/dstack.sock", "dstack"),
    ("/var/run/tappd.sock", "phala-tappd"),
)


def tee_status(secrets_from_files: list[str] | None = None) -> dict:
    """Which confidential-compute guest interface is visible, if any.

    Reports booleans and a type label only — never secret material, paths of secret
    files, or the quote itself. `detected` is a deployment sanity check ("did I
    actually land on confidential hardware?"), not an attestation: only the party that
    verifies a quote can establish trust, and that happens outside this process.
    """
    found = next((label for path, label in _TEE_PROBES if os.path.exists(path)), None)
    return {
        "detected": found is not None,
        "type": found,
        "secrets_from_files": sorted(secrets_from_files or []),
    }
