# Jev Trader web

Next.js dashboard for the Bybit bot. It shows SOLUSDT and XRPUSDT side by side: price, the model's buy or sell call, the resting quote, fills, and P&L.

## Run

From this folder, with the API already running (see the repo README):

```sh
bun install
copy .env.example .env.local
bun run dev
```

On macOS or Linux use `cp .env.example .env.local` instead of `copy`.

`NEXT_PUBLIC_API_URL` is the API origin, default `http://localhost:3000`. The page opens `$NEXT_PUBLIC_API_URL/events`.

If the API is on port 3000, start Next on another port:

```sh
bun run dev -- --port 3001
```
