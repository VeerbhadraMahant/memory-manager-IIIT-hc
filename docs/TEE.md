# Running the API keys inside a Trusted Execution Environment

## What a TEE does and does not give you here

A TEE (AMD SEV-SNP / Intel TDX confidential VMs, AWS Nitro Enclaves, Azure and GCP
confidential containers, dstack/Phala CVMs, SGX via Gramine) encrypts the workload's memory
and lets a remote party **verify what code is running** before trusting it with a secret.

| Protected | Not protected |
|---|---|
| API keys and the DB password while in process memory — the host operator cannot read them | **Prompts and memories sent to OpenRouter / Groq / Gemini.** They leave the enclave over TLS and are visible to those providers. Only an inference endpoint that is itself in a TEE (set `LLM_BASE_URL` to it) closes this gap. |
| The decision *which code* gets the secrets (attestation-gated release) | The Supabase database. Postgres is not in your enclave; enable Supabase's encryption at rest and treat it as a trusted-by-contract third party. |

State this plainly when describing the system: the TEE protects **credentials and process
memory**; it does not make third-party model providers confidential.

## How this backend handles keys (`backend/app/secrets.py`)

1. **Secrets arrive at runtime, never in the image.** Each of `DATABASE_URL`, `LLM_API_KEY`,
   `GROQ_API_KEY`, `GEMINI_API_KEY`, `SESSION_SECRET`, `SUPABASE_JWT_SECRET` can be given as
   `NAME_FILE=/run/secrets/x` (preferred), `$SECRETS_DIR/<name>` (default `/run/secrets`), or the
   plain `NAME` environment variable — in that precedence order. The Dockerfile contains no
   secrets, no `ARG`s for them, and no `.env`.
2. **File-provided secrets never enter `os.environ`.** They are passed straight into the
   settings object. Env-provided ones are **deleted from `os.environ` after load**, so child
   processes and in-process introspection cannot read them. (The kernel's initial
   `/proc/<pid>/environ` snapshot cannot be erased — another reason to prefer files.)
3. **Typed as `SecretStr`.** They print as `**********` in reprs, tracebacks and `model_dump()`;
   the raw value is unwrapped only in the accessor properties (`settings.dsn`, `.llm_key`,
   `.groq_key`, `.gemini_key`) and the two token-verification call sites in `auth.py`, and is put
   on the wire only as an `Authorization` / `x-goog-api-key` header.
4. **Never in URLs.** Gemini's key used to be sent as `?key=...`, which `httpx` echoes into
   exception text — and that text was returned to the browser in 502 bodies. It now travels in a
   header, and upstream error text is no longer returned to clients at all.
5. **Redaction everywhere else.** A logging filter on the root handler scrubs OpenRouter/Groq/
   Google key shapes, bearer tokens, JWTs, `?key=` parameters, DSN passwords, and the exact
   registered secret values from every record and traceback. `httpx` request logging is silenced.
6. **Pinned, TLS-only egress.** In production the config validator rejects non-`https://`
   provider URLs; redirects are not followed (they would replay the `Authorization` header).
7. **`REQUIRE_TEE=true`** makes the process refuse to start unless a confidential-compute guest
   interface is visible (`/dev/sev-guest`, `/dev/tdx_guest`, `/dev/nsm`, `/dev/attestation`, dstack
   socket). `GET /tee` reports the detected type and which secrets were file-loaded — booleans
   and labels only.

### What this app cannot do for you

* **It does not verify attestation.** `REQUIRE_TEE` is a "did I land on confidential hardware"
  check, not proof. Trust is established by the party that *releases* the secret — your KMS or
  secrets broker — verifying the platform's attestation quote against your expected measurement
  **before** handing over a key. This app consumes the result of that release.
* It has not been run on real TEE hardware. The detection probes and the secrets-from-files path
  are tested (`backend/tests/test_secrets.py`; a production-mode boot with file secrets was
  exercised locally), but the platform wiring below is guidance to validate on your target.

## Wiring it up per platform

The pattern is the same everywhere: **attested release → write to tmpfs → `NAME_FILE`**.

* **dstack / Phala CVM** — put the compose from `deploy/docker-compose.prod.yml` in the CVM.
  Encrypted environment variables are decrypted only inside the CVM; mount them as files or set
  `REQUIRE_TEE=true` and keep them as env (they are scrubbed after load).
* **GCP Confidential Space** — workload identity is granted only to an attested image digest;
  fetch secrets from Secret Manager at start-up into a tmpfs path and set `*_FILE`.
* **Azure Confidential Containers / VMs** — use Key Vault *secure key release* (MAA-attested)
  from an init container that writes to a shared `emptyDir: {medium: Memory}` volume.
* **AWS Nitro Enclaves** — the enclave has no network. Run a `vsock` proxy for outbound HTTPS
  (OpenRouter, Supabase) and release secrets through KMS with an attestation-bound key policy
  (`kms:RecipientAttestation`). Enclaves also need the image converted to an EIF
  (`nitro-cli build-enclave`); not covered by the provided compose file.
* **Plain VM / no TEE** — everything still works; you simply get steps 2–6 and not the hardware
  guarantee. Use `REQUIRE_TEE=false` (default).

## Rotating a key

Replace the secret file (or secret-store entry) and restart the container. There is no
in-process cache of provider keys beyond the pooled HTTP clients, which are rebuilt on start.
