# syntax=docker/dockerfile:1.7
#
# Backend image. Build context is ./backend:   docker build -t nam-backend ./backend
#
# Hardening choices that matter for a confidential-compute (TEE) deployment:
#   * no secrets of any kind are baked in or ARG'd — they are injected at runtime
#     (NAME_FILE / mounted secrets / env), see docs/TEE.md;
#   * runs as an unprivileged user and writes nothing to its own filesystem, so it works
#     with `read_only: true`, `cap_drop: [ALL]` and no-new-privileges;
#   * dependencies come from requirements.lock (exact versions), not floating ranges.

FROM python:3.13-slim AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /build
COPY requirements.lock .
RUN python -m venv /opt/venv && /opt/venv/bin/pip install -r requirements.lock

FROM python:3.13-slim AS runtime
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/backend \
    ENVIRONMENT=production \
    LOG_JSON=true

# tini reaps zombies and forwards SIGTERM so uvicorn can drain in-flight LLM calls.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin app

COPY --from=build /opt/venv /opt/venv
WORKDIR /app/backend
COPY app ./app
COPY migrations ./migrations
COPY scripts ./scripts
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

USER 10001
EXPOSE 8000

# Liveness only (no DB), so a database blip does not make the orchestrator kill a healthy app.
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3).status==200 else 1)"

ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
# --proxy-headers so request.client / rate limiting see the real client behind your TLS proxy.
# FORWARDED_ALLOW_IPS must list the proxy's address in production; '*' trusts any hop.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers ${WEB_CONCURRENCY:-2} --proxy-headers --forwarded-allow-ips=${FORWARDED_ALLOW_IPS:-127.0.0.1} --timeout-graceful-shutdown 30"]
