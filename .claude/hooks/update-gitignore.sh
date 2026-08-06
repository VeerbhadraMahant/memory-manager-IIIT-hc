#!/usr/bin/env bash
#
# Stop hook: keep .gitignore covering build artifacts as the project grows.
#
# Deliberately narrow. A shell script cannot judge whether a file *should* be
# tracked, so it only auto-adds patterns that are never legitimately committed
# (node_modules, __pycache__, coverage output, and so on). Anything it is not
# certain about — a stray key or .env variant showing up untracked — is reported
# and left alone, because silently ignoring a file the user wanted tracked is a
# worse failure than a missing line in .gitignore.
#
# Never blocks: always exits 0.

set -uo pipefail

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" 2>/dev/null || exit 0
[ -f .gitignore ] || exit 0   # do not conjure one; that is a decision, not maintenance

needed=()
secrets=()

want() {
  local p="$1"
  # already covered?
  grep -Fxq -- "$p" .gitignore 2>/dev/null && return
  case " ${needed[*]-} " in *" $p "*) return ;; esac
  needed+=("$p")
}

while IFS= read -r f; do
  [ -n "$f" ] || continue
  base="${f##*/}"

  case "$f" in
    *node_modules/*)     want "node_modules" ;;
    *__pycache__/*)      want "__pycache__/" ;;
    *.egg-info/*)        want "*.egg-info/" ;;
    *.pytest_cache/*)    want ".pytest_cache/" ;;
    *.ruff_cache/*)      want ".ruff_cache/" ;;
    *.mypy_cache/*)      want ".mypy_cache/" ;;
    *.next/*)            want ".next/" ;;
    *.turbo/*)           want ".turbo/" ;;
    *htmlcov/*)          want "htmlcov/" ;;
    *.venv/*|*venv/*)    want ".venv/" ;;
  esac

  case "$base" in
    *.pyc|*.pyo)         want "*.py[cod]" ;;
    *.log)               want "*.log" ;;
    .coverage|.coverage.*) want ".coverage" ;;
    *.tsbuildinfo)       want "*.tsbuildinfo" ;;
    *.orig|*.rej|*.bak)  want "*.${base##*.}" ;;
  esac

  # Not auto-added. If one of these is showing as untracked, .gitignore has a real
  # gap — but the right pattern depends on what the file actually is, so say so
  # rather than guess.
  case "$base" in
    .env.example) ;;
    .env|.env.*|*.pem|*.key|*.p12|*.pfx|*service-account*.json|*.dump)
      secrets+=("$f") ;;
  esac
done < <(git status --porcelain --untracked-files=all 2>/dev/null | sed -n 's/^?? //p')

msg=""

if [ "${#needed[@]}" -gt 0 ]; then
  marker="# --- added automatically as artifacts appeared ---"
  grep -Fxq -- "$marker" .gitignore 2>/dev/null || {
    printf '\n%s\n' "$marker" >> .gitignore
  }
  for p in "${needed[@]}"; do
    printf '%s\n' "$p" >> .gitignore
  done
  msg="gitignore: added ${needed[*]}"
fi

if [ "${#secrets[@]}" -gt 0 ]; then
  [ -n "$msg" ] && msg="$msg. "
  msg="${msg}UNIGNORED and sensitive-looking, not auto-added: ${secrets[*]}"
fi

[ -n "$msg" ] || exit 0

# Hand-rolled JSON: jq is not installed here. Strip characters that would need
# escaping rather than risk emitting malformed JSON that the hook runner drops.
clean=$(printf '%s' "$msg" | tr -d '"\\' | tr '\n' ' ')
printf '{"systemMessage": "%s"}\n' "$clean"
exit 0
