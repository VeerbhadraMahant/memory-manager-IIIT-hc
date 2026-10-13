# Secret files (never committed)

Create one file per secret, containing only the value (a trailing newline is stripped):

| file | value |
|---|---|
| `database_url.txt` | Supabase connection string (session pooler or direct), with `?sslmode=require` |
| `llm_api_key.txt` | OpenRouter key (`sk-or-v1-...`) |
| `session_secret.txt` | `openssl rand -base64 48` — only used by Google sign-in |

```bash
umask 077
printf '%s' 'postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require' > database_url.txt
openssl rand -base64 48 | tr -d '\n' > session_secret.txt
```

Everything in this directory except this README is gitignored.
