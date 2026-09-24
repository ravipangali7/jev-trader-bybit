# jev-trader

A Bun and TypeScript market maker. About every 300 ms it reads the Bybit order book, asks a model whether price goes up or down, and rests **one post-only limit order** on that side, a few ticks inside the touch, replacing the previous order. Fills happen when a taker hits it.

It quotes **SOLUSDT** and **XRPUSDT** at the same time. Each symbol has its own book, position, size, and P&L.

This is a fork of [jarrodwatts/jev-trader](https://github.com/jarrodwatts/jev-trader) by Jarrod Watts (MIT). The original posts on Kuru's MON-USDC book every Monad block. This fork keeps that strategy and the Jev model, and talks to Bybit v5 instead of Monad. The [LICENSE](LICENSE) is unchanged.

## Dry run, testnet, live

| Mode | What happens |
| --- | --- |
| Dry run (default) | Live Bybit public books and trades. Real model decisions. Orders are simulated: they rest and fill when a real trade crosses the price. No API keys. |
| Testnet | `BYBIT_TESTNET=true` and `DRY_RUN=false` with testnet keys. Orders go to Bybit testnet. |
| Mainnet | `BYBIT_TESTNET=false` and `DRY_RUN=false` with mainnet keys. Real orders, real money. |

Live orders are sent only when **both** keys are set **and** `DRY_RUN=false`. Anything else stays a dry run.

`BYBIT_CATEGORY=linear` (default) is the USDT perpetual. Long and short both work, and the position cap is in base coin. P&L is in USDT. The bot assumes one-way mode (`BYBIT_POSITION_IDX=0`). Hedge mode needs 1 for buys and 2 for sells.

`BYBIT_CATEGORY=spot` is the spot book. Post-only limits work the same way. Bybit will not let a spot sell exceed the base coin you hold, because this bot does not borrow. A dry run still simulates a short so the strategy can be watched. Live spot sells that the wallet cannot fund are rejected and the bot tries the other side.

## Safety

- Position cap per symbol (`SOLUSDT_MAX_POSITION`, `XRPUSDT_MAX_POSITION`).
- `MAX_LOSS_USD` (default 25) is a kill switch on this process's P&L across both symbols. It cancels every open order and stops quoting. Restart the process to quote again.
- On shutdown (Ctrl+C or SIGTERM) every open order on these symbols is cancelled.
- Secrets stay in `.env`, which is gitignored. Do not commit keys.

P&L uses Bybit maker fees, not gas. A dry run uses the published non-VIP schedule (linear maker 0.02% and taker 0.055%, spot 0.10% both sides). With keys, the bot reads `/v5/account/fee-rate`. `MAKER_FEE_RATE` and `TAKER_FEE_RATE` override both.

Tick size, quantity step, and minimum size come from `/v5/market/instruments-info`. If that call fails, a **dry run** infers the tick and quantity step from the live book and assumes a 5 USDT minimum, and keeps retrying. A **live** process refuses to start without instruments-info, so it will not send a real order on a guessed grid.

## Run

Install [Bun](https://bun.sh), then:

```sh
cp .env.example .env
bun install
bun run start
```

Windows 11, Command Prompt (Bun already on PATH):

```bat
copy .env.example .env
bun install
bun run start
```

Windows 11, PowerShell:

```powershell
Copy-Item .env.example .env
bun install
bun run start
```

The API listens on `http://localhost:3000`. With `MODEL=mock` you should see a decision and a simulated quote for SOLUSDT and for XRPUSDT a few times a second. No keys required.

### Jev

In `.env`:

```
MODEL=jev
TYPESAFE_AI_API_KEY=your_key
```

`MODEL=mock` is a momentum stand-in and sleeps ~80 ms so the loop behaves like inference. Jev is the TypeSafe model (`JEV_MODEL_ID`, default `jev-latest`) through the AI SDK. The model only chooses buy or sell. Code places the order.

### Live trading

1. Create a Bybit API key that can trade the category you set. Do not enable withdrawals.
2. Put the key and secret in `.env`.
3. Prefer testnet first: `BYBIT_TESTNET=true` and `DRY_RUN=false`.
4. Mainnet: `BYBIT_TESTNET=false` and `DRY_RUN=false`.
5. Set size and `MAX_LOSS_USD` to amounts you can lose.
6. `bun run start`. Leftover open orders on these symbols are cancelled at startup.

The loop is `LOOP_MS` (default 300). Two symbols at that pace, one amend or create each, stay under Bybit's published 10 orders/second limit. `MAX_ORDERS_PER_SEC` (default 8) is a local cap. If the model is still thinking when the next tick arrives, that tick is late and quotes nothing.

## Dashboard

```sh
cd web
bun install
```

Point it at the API. Copy `web/.env.example` to `web/.env.local` (it already says `http://localhost:3000`), then:

```sh
bun run dev
```

Windows: `copy .env.example .env.local` from the `web` folder, then `bun run dev`. Open the URL Next prints (usually `http://localhost:3000` on the web app; if the API is also on 3000, Next will pick another port).

The page shows both symbols: price, the buy/sell call, the resting quote, fills, and P&L.

## Endpoints

- `GET /` snapshot: model, dry run, category, testnet, fees, kill switch, latest event per symbol
- `GET /history` last 1000 events per symbol
- `GET /history/SOLUSDT` one symbol
- `GET /events` SSE: `snapshot` on connect, then `block` (one decision), `fill`, `status`, `ping`

A `block` event looks like:

```json
{
  "symbol": "SOLUSDT",
  "tick": 12,
  "mid": 117.02,
  "bestBid": 117.01,
  "bestAsk": 117.03,
  "spreadBps": 1.71,
  "decision": { "action": "buy", "probabilities": { "buy": 0.62, "sell": 0.38, "hold": 0 }, "upIn10": 0.62, "latencyMs": 81, "late": false },
  "quote": { "side": "buy", "price": 117.02, "size": 0.1, "status": "sim", "capped": false, "orderId": "sim-3" },
  "position": { "side": "flat", "size": 0, "entryPrice": null, "unrealizedUsd": 0 },
  "totals": { "ticks": 12, "decisions": 12, "quotes": 12, "fills": 0, "feesUsd": 0, "pnlUsd": 0, "pnlPct": 0 }
}
```

`hold` is only a late tick (the previous decision was still running). `capped: true` means the position cap or the wallet forced the other side. The probabilities are still the model's call. `status` is `sim` in a dry run, or `placed`, `amended`, `kept`, or `rejected` live.

## Layout

```
src/config.ts            env, per-symbol size and caps
src/model.ts             Jev and the mock model
src/trader.ts            one symbol: decide, quote, position, P&L, kill switch
src/server.ts            snapshot, history, SSE
src/bybit/public.ts      public WebSocket order book and trades
src/bybit/venue.ts       private REST orders and private WebSocket fills
src/bybit/instrument.ts  tick size, qty step, minimum size
src/index.ts             both symbols, timer, shutdown
web/                     Next.js dashboard
```

## Checks

```sh
bun test
bun run typecheck
```
