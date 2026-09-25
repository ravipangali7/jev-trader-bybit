# Jev Trader web

Next.js dashboard for the Bybit bot. It shows SOLUSDT and XRPUSDT side by side: price, the model's buy or sell call, the resting quote, fills, and P&L. Below the books: paper equity, a P&L chart, and the trade list.

## Run

From this folder, with the API already running (see the repo README):

```sh
bun install
copy .env.example .env.local
bun run dev
```

On macOS or Linux use `cp .env.example .env.local` instead of `copy`.

`NEXT_PUBLIC_API_URL` is the API origin. `web/.env.example` points at `http://127.0.0.1:3100`. The page opens `$NEXT_PUBLIC_API_URL/events`, `/summary`, `/trades`, and `/equity`.

Start Next on 3101 when the bot is on 3100:

```sh
bun run dev -- --port 3101
```
