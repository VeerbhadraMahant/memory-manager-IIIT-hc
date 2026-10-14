# Frontend

Next.js 16 (App Router), React 19, Tailwind v4, Radix primitives. Talks to the FastAPI
backend over `NEXT_PUBLIC_API_BASE`.

```bash
cd frontend && npm install
NEXT_PUBLIC_API_BASE=http://127.0.0.1:8000 npm run dev      # http://localhost:3000
npm run lint && npm run build
```

## Routes

| Path | What | Auth |
|---|---|---|
| `/` | Landing page | public |
| `/app` | The workspace: conversation, memory panel, review cards | gated (see below) |
| `/graph` | Full-page memory graph | gated |

The gate lives in `app/(workspace)/layout.tsx`, so the landing page is readable without
signing in. What "gated" means is decided by the backend (`GET /auth/config`): with
`AUTH_REQUIRED=false` the workspace opens as the shared demo user; otherwise it shows the
sign-in screen (Supabase or Google — `lib/auth-context.tsx`). See `docs/DEPLOYMENT.md`.

## Design system

The look is the **"Tableland"** style from styles.refero.design, applied to the product:
a green-black dark surface, Poppins with weight 300 on headings, teal for everything you
can press, mint for emphasis, flat surface steps instead of shadows, and one painted moment
(the coral-and-lavender hero). Everything is a token in `app/globals.css`; components spend
tokens, never hex, so restyling is a change to that one file.

| Token | Value | Use |
|---|---|---|
| `--bg` Void | `#101E1E` | page canvas |
| `--surface` / `--surface-raised` Slate | `#162929` | cards, panels |
| `--surface-sunken` Carbon | `#1A1A1A` | inputs, terminals, sidebar |
| `--surface-elevated` Graphite | `#3B4949` | tooltips, menus, popovers only |
| `--accent` Abyss Teal | `#75B6B5` | links, icons, focus ring |
| `--action` Ash | `#E5E7EB` | the primary button (Void text on it, 13.8:1) |
| `--stated` Mint Beacon | `#0BE291` | "you said this", the one emphasised heading |
| `--inferred` / `--lavender` | `#E4CBF2` | "the model inferred this"; the hero band |
| `--danger` / `--alert` Coral Ember | `#F4706B` | destructive actions and cautions |

Deliberate departures from the reference, because it describes a marketing site and this is a
product (each is also recorded in the header comment of `globals.css`):

- **Muted text is `#A8BEBE`, not Fog `#718B8B`.** Fog measures 4.17:1 on Slate and 2.58:1 on
  Graphite, below AA for the 12–14px secondary text used on both. Fog remains as `--fog` for
  strokes and disabled glyphs.
- **Mint is used for "stated" as well as for the emphasised heading,** because stated vs.
  inferred is the distinction the product exists to show and needs a colour that is not the
  interactive teal. It is always paired with a text label and a dot/ring glyph.
- **Hairlines are Ash at low alpha,** not solid Ash.
- **Danger and alert share Coral** (the palette has no red or amber); they differ by icon,
  label and fill.
- **Composer modes colour only the active badge,** keeping to one chromatic colour per region.

All text pairs are measured; the table is in the `globals.css` header. Touch targets are 44px,
focus rings are never removed, and motion respects `prefers-reduced-motion`.

## Brand art

`public/brand/hero.svg` and `mark.svg` are **generated**, not hand-edited:
`python3 frontend/scripts/build_brand_art.py`. They are vector because the style is flat
polygons with no outlines or texture, which is exactly what SVG is — a few KB and sharp at
any size. `og.png` (the social card) is rendered from `scripts/og.html` with Chromium (the
command is in that file). `app/icon.svg` is the favicon.
