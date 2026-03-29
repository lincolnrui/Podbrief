# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start dev server (Express + Vite HMR)
npm run build    # Build frontend for production
npm run lint     # TypeScript type-check (no emit)
npm run clean    # Remove dist/
```

**Local dev server**: Port 3000 is often occupied. Use `$env:PORT=3001; npm run dev` in PowerShell.

No test suite is configured.

## Architecture

**PodBrief** is a podcast digest tool that tracks YouTube channels, auto-summarizes episodes using MiniMax AI, and provides AI chat about episode content. Stored in Supabase.

### Server model (dual-mode)

`server.ts` is the single entry point for both dev and production. It:
- Contains **inline implementations** of `/api/summarize` and `/api/chat` — it does NOT import from `api/`
- In dev: integrates Vite as middleware (HMR enabled)
- In production: serves the built `dist/` as static files with SPA fallback

On **Vercel**, the `api/` files are treated as serverless functions. Locally the inline handlers in `server.ts` are used. **Always edit both `server.ts` AND the corresponding `api/` file to keep them in sync.**

### AI backend: MiniMax M2.7

All AI calls use `@anthropic-ai/sdk` pointed at MiniMax's Anthropic-compatible endpoint:

```typescript
const client = new Anthropic({
  apiKey: process.env.MINIMAX_API_KEY,
  baseURL: 'https://api.minimax.io/anthropic',
});
// model: 'MiniMax-M2.7', max_tokens: 1024
```

**Critical**: MiniMax returns a `thinking` block before the text block. Always extract text as:
```typescript
const textBlock = response.content.find(b => b.type === 'text');
const text = textBlock ? textBlock.text : '';
```

### Data flow

```
YouTube channel → /api/youtube/historical (30 days)
                       ↓
            /api/youtube/transcript  (text + segments[{text, offset}] + duration)
                       ↓
              /api/summarize  (MiniMax M2.7 → JSON: {summary, key_points[], topics[]})
                       ↓
              Supabase (episodes table)
                       ↓
              React pages (Feed / EpisodeDetail / Chat)
```

### API layer (`api/`)

Each file exports a single `handler(req, res)` function:

| File | Purpose |
|------|---------|
| `api/summarize.ts` | Transcript → `{ summary, key_points[], topics[] }` (JSON) |
| `api/chat.ts` | Conversational chat with episode/feed context |

YouTube endpoints live in `server.ts` only (not duplicated in `api/`).

All YouTube endpoints filter out Shorts (HEAD request to `/shorts/` URL).

### Frontend (`src/`)

Single-page app with React Router. Four pages:

- **Feed** (`/`) — Calls `/api/youtube/historical?days=30` per channel, triggers summarization, displays episode cards. Skipped videos (no transcript) shown in UI.
- **Channels** (`/channels`) — Add/remove channels. Adding triggers 30-day backfill with 2s delays. Skipped videos shown in UI.
- **Chat** (`/chat`) — Global chat against last 14 days of episodes.
- **EpisodeDetail** (`/episode/:id`) — Summary, clickable key insights, YouTube embed, episode-scoped chat with timestamp citations.

`src/lib/gemini.ts` — Client-side helper (despite the name) that chains `/api/youtube/transcript` → `/api/summarize`. Throws `NO_TRANSCRIPT` if no transcript, `VIDEO_TOO_SHORT` if too short.

`src/lib/supabase.ts` — Exports the Supabase client and `isSupabaseConfigured` flag.

### EpisodeDetail — timestamp citation system

When the AI answers a question, a second API call sends the response paragraphs + a condensed timestamped outline (every 10th transcript segment) and asks the AI to return a JSON array of timestamps — one per paragraph. Each paragraph then shows a `▶ 3:35:37` button that seeks the embedded YouTube player. ~30 second accuracy.

### Database schema (Supabase)

**`channels`**: `id`, `name`, `youtube_channel_id` (24-char `UC...` format), `description`

**`episodes`**: `id`, `channel_id` (FK), `youtube_video_id`, `title`, `published_at`, `thumbnail_url`, `summary`, `key_points` (string[]), `fetched_at`

### Environment variables

| Variable | Required | Notes |
|----------|----------|-------|
| `MINIMAX_API_KEY` | Yes | MiniMax API key (server-side only) |
| `YOUTUBE_API_KEY` | No | Falls back to RSS if missing |
| `VITE_SUPABASE_URL` | Yes | Also as `NEXT_PUBLIC_SUPABASE_URL` |
| `VITE_SUPABASE_ANON_KEY` | Yes | Also as `NEXT_PUBLIC_SUPABASE_ANON_KEY` |

### Key constraints

- Videos shorter than 20 minutes are rejected (`VIDEO_TOO_SHORT`) at both API and client level.
- Videos with no transcript are skipped (`NO_TRANSCRIPT`) and shown to the user in the UI.
- Summarization prompt instructs the model to respond in the same language as the transcript.
- MiniMax/AI calls in batch operations are rate-limited with 2-second delays.
- Express body parser limit is `10mb` (large transcripts).
- `vite.config.ts` exposes `NEXT_PUBLIC_SUPABASE_*` env vars to the browser via `define`.
- Chat markdown rendered with `react-markdown` + `remark-gfm` (tables, bold, lists).
