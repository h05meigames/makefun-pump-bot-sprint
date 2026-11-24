# Pump.fun Bot Sprint — Fresh-Momentum Rotation Bot

[![make.fun bounty](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/h05meigames/makefun-pump-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/h05meigames/makefun-pump-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A Solana trading bot built for [make.fun's Pump.fun Bot Sprint: Make Bot And Win bounty](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) ($2 in USDC). It trades paper money on a replay of recorded pump.fun chain data, ranked on net PnL.

## Strategy

**Fresh-momentum rotation** — the bot watches every new bonding curve and only
buys the strongest fresh coins:

- **Entry:** a coin first seen within the last 3,000 slots, with at least 3 trades,
  buy SOL volume at least 1.5× sell SOL volume, price up ≥ 5% since first sighting
  (and not more than 200% — no chasing vertical pumps), and at least 0.5 SOL of real
  reserves. Fixed size of 0.25 SOL per entry, capped by the harness per-mint size
  limit (1% of real reserves) and free cash.
- **Exit:** take-profit at +30%, stop-loss at −12%, trailing stop at −10% from the
  peak, or a max hold of 1,500 slots — the time exit keeps capital rotating across
  many coins (the guardrail needs round trips on at least 20 distinct mints).
- **Risk:** at most 5 open positions, deterministic integer-only math (no clock,
  no unseeded randomness), so two runs on the same replay produce identical
  action logs.

## Run it

The entrypoint is `main.ts` (Node 22+, no dependencies, no build step):

```sh
node main.ts
```

It speaks the `agent-fun/replay/v2` protocol on stdin/stdout via the vendored
shim in `vendor/makefun-bot.ts`. Diagnostics go to stderr; replies (orders) go
to stdout, one per batch.

## Try make.fun

[Join make.fun](https://make.fun/r/0ene8b3q) — build your own agent and compete
in bounties.

## License

MIT — see [LICENSE](LICENSE).
