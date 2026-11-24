// Pump.fun Bot Sprint entry — "fresh-momentum rotation".
//
// Strategy, written from scratch for the agent-fun/replay/v2 harness:
//   * The harness sends a `hello` once, then one `batch` per slot with that slot's
//     market events, marks and fills; the bot answers each batch with its orders.
//   * The bot watches every new bonding curve, measures its early momentum from the
//     trade flow itself (buy vs sell SOL volume, price move since first sighting),
//     buys a fixed small size into the strongest fresh coins, and exits on a
//     take-profit, a stop-loss, a trailing stop, or a max hold time so capital
//     keeps rotating across many coins (the guardrail needs round trips on at
//     least 20 distinct mints).
//   * Entry needs a confirmed trend, not just any uptick: at least 10 observed
//     trades, price up >= 5% since first sighting, buy volume >= 3x sell volume,
//     still rising on the latest trade and still within 5% of its observed peak —
//     enter only into sustained buying, because the 2-slot fill latency eats two
//     slots of adverse move on both sides. Exits: +25% take-profit, -8% stop-loss,
//     -8% trailing stop, 900-slot max hold. A selective scalp, not a swing.
//   * Everything is deterministic: all decisions come from slot numbers and event
//     data only — no clock, no environment, no unseeded randomness — so two runs
//     on the same replay produce byte-identical action logs.
//
// Price is kept as a scaled bigint: price = virtual_quote_reserves * SCALE /
// virtual_token_reserves (lamports per token, scaled), so every comparison is
// exact integer math and no floating point ever enters a decision.

import { runBot, type Batch, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

const SCALE = 1_000_000_000n; // price scale factor (lamports per token * SCALE)
const BUY_SIZE_LAMPORTS = 250_000_000n; // 0.25 SOL per entry
const MIN_BUY_LAMPORTS = 50_000_000n; // never open below 0.05 SOL (guardrail needs 0.01 SOL round trips)
const MAX_OPEN = 5; // harness caps.max_open_positions
const MAX_HOLD_SLOTS = 900; // force rotation: exit a position this old (slow bleeders get cut)
const FRESH_SLOTS = 3000; // only enter coins first seen within this many slots
const MIN_TRADES = 10; // need at least this many trades before trusting the flow
const MIN_REAL_SOL_RESERVES = 500_000_000n; // 0.5 SOL of real reserves: skip dust curves
// Slippage: 500 bps rejected 3,703 orders under the loose v1 filters, but with
// selective entries (10+ trades, 3x dominance) fills land close to the decision
// price and the tighter cap keeps bad fills out; an offline replay of the dev
// dataset showed 500 bps beating 800 bps at this selectivity.
const SLIPPAGE_BPS = 500;
// After a buy is rejected, wait this many slots before retrying the same mint
// instead of spamming a retry on every batch.
const REJECT_COOLDOWN_SLOTS = 15;

// Entry filters (all in integer percent, applied to scaled prices):
// Evidence from replaying the dev dataset offline (~128k events, 1,222 coins):
// coins spike a median +26% from their first trade then bleed below their start
// (only 10% end above it), so the money is in catching a confirmed spike early
// and leaving fast. Every alternative structure tested lost far more — buying the
// first trade (-8.6 SOL), buying pullbacks/dips (-8 to -13 SOL), chasing new highs
// (-3.1 SOL), riding to completion (-1.7 to -3.6 SOL). Within this momentum family,
// selectivity is what pays: 10+ observed trades and 3x buy dominance cut the dev
// loss from -0.85 SOL (loose filters) to a -0.05 SOL plateau, with ~100 round
// trips over ~98 distinct coins — comfortably above the 20-mint guardrail — and
// the plateau is flat across TP 20-30 / hold 900-1500, so these are robust picks,
// not a sharp overfit peak.
const MIN_MOMENTUM_PCT = 5; // price up >= 5% since first sighting
const MAX_MOMENTUM_PCT = 60; // price up <= 60% since first sighting (enter early, don't chase)
const BUY_DOMINANCE_NUM = 6; // buy SOL volume >= 3x sell SOL volume (6/2)
const BUY_DOMINANCE_DEN = 2;
const NEAR_PEAK_PCT = 5; // entry price within 5% of the mint's observed peak

// Exit rules (integer percent of entry price / peak price):
const TAKE_PROFIT_PCT = 25;
const STOP_LOSS_PCT = 8;
const TRAILING_STOP_PCT = 8;

interface MintStats {
  firstPrice: bigint;
  lastPrice: bigint;
  prevPrice: bigint; // price before the latest trade (still-rising check)
  peakPrice: bigint; // highest price seen, held or not (near-peak check)
  buyVol: bigint;
  sellVol: bigint;
  trades: number;
  firstSeenSlot: number;
  createdSlot: number | null;
  entryPrice: bigint | null;
  entrySlot: number;
  coolUntilSlot: number; // don't retry a rejected buy before this slot
}

/** Scaled price of a curve from its virtual reserves; 0n when reserves are empty. */
function priceOf(virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken <= 0n) return 0n;
  return (virtualQuote * SCALE) / virtualToken;
}

/** True when a is at least pct% above b (integer math). */
function upAtLeastPct(a: bigint, b: bigint, pct: number): boolean {
  return a * 100n >= b * BigInt(100 + pct);
}

/** True when a is at least pct% below b (integer math). */
function downAtLeastPct(a: bigint, b: bigint, pct: number): boolean {
  return a * 100n <= b * BigInt(100 - pct);
}

const stats = new Map<string, MintStats>();
let batchesSeen = 0;
let buysSent = 0;
let sellsSent = 0;

function statsFor(mint: string, slot: number): MintStats {
  let s = stats.get(mint);
  if (s === undefined) {
    s = {
      firstPrice: 0n,
      lastPrice: 0n,
      prevPrice: 0n,
      peakPrice: 0n,
      buyVol: 0n,
      sellVol: 0n,
      trades: 0,
      firstSeenSlot: slot,
      createdSlot: null,
      entryPrice: null,
      entrySlot: 0,
      coolUntilSlot: 0,
    };
    stats.set(mint, s);
  }
  return s;
}

await runBot({
  onHello(state: BotState): void {
    console.error(
      `[bot] hello: capital=${state.hello.capital.lamports} lamports ` +
        `maxOpen=${state.hello.caps.max_open_positions} ` +
        `maxOrdersPerBatch=${state.hello.caps.max_orders_per_batch} seed=${state.hello.seed}`,
    );
  },

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    batchesSeen++;
    const orders: OrderInput[] = [];
    const slot = batch.slot;

    // --- 1. Fold this batch's events into per-mint flow stats. ---
    for (const e of batch.events) {
      const s = statsFor(e.mint, slot);
      if (e.event === 'CreateEvent') {
        s.createdSlot = e.slot;
        const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (s.firstPrice === 0n) s.firstPrice = p;
        s.lastPrice = p;
      } else if (e.event === 'TradeEvent') {
        const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (s.firstPrice === 0n) s.firstPrice = p;
        s.prevPrice = s.lastPrice;
        s.lastPrice = p;
        if (p > s.peakPrice) s.peakPrice = p;
        s.trades += 1;
        if (e.is_buy) s.buyVol += BigInt(e.sol_amount);
        else s.sellVol += BigInt(e.sol_amount);
      } else {
        // CompleteEvent: the curve is done; forget any entry (the harness closes it).
        s.entryPrice = null;
      }
    }

    // --- 2. Record buy fills as entries (price at the batch they land), and
    // cool down mints whose buy was rejected so we stop retrying every batch. ---
    for (const f of batch.fills) {
      const s = statsFor(f.mint, slot);
      if (f.status === 'rejected' && f.side === 'buy') {
        s.coolUntilSlot = f.slot + REJECT_COOLDOWN_SLOTS;
        continue;
      }
      if (f.status !== 'filled') continue;
      const curve = state.curves.get(f.mint);
      if (curve === undefined) continue;
      const p = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (f.side === 'buy') {
        s.entryPrice = p;
        s.entrySlot = f.slot;
        s.peakPrice = p;
      } else {
        s.entryPrice = null;
      }
    }

    // --- 3. Update peak prices for held mints from the latest curve state. ---
    for (const [mint, holding] of state.positions) {
      void holding;
      const curve = state.curves.get(mint);
      const s = stats.get(mint);
      if (curve === undefined || s === undefined || s.entryPrice === null) continue;
      const p = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      s.lastPrice = p;
      if (p > s.peakPrice) s.peakPrice = p;
    }

    // --- 4. Exits: take-profit, stop-loss, trailing stop, max hold time. ---
    for (const [mint, holding] of state.positions) {
      // BUG FIX (found in dev grading): the old code sent a sell on every batch
      // until the fill landed 2 slots later, emitting 3-4 duplicate sells per
      // exit. Skip a mint that already has a sell pending.
      let pendingSell = false;
      for (const p of state.pending.values()) {
        if (p.order.side === 'sell' && p.order.mint === mint) {
          pendingSell = true;
          break;
        }
      }
      if (pendingSell) continue;
      const s = stats.get(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      const p = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      let exit = false;
      let why = '';
      if (s !== undefined && s.entryPrice !== null && s.entryPrice > 0n) {
        if (upAtLeastPct(p, s.entryPrice, TAKE_PROFIT_PCT)) {
          exit = true;
          why = 'take-profit';
        } else if (downAtLeastPct(p, s.entryPrice, STOP_LOSS_PCT)) {
          exit = true;
          why = 'stop-loss';
        } else if (s.peakPrice > 0n && downAtLeastPct(p, s.peakPrice, TRAILING_STOP_PCT)) {
          exit = true;
          why = 'trailing-stop';
        } else if (slot - s.entrySlot > MAX_HOLD_SLOTS) {
          exit = true;
          why = 'max-hold';
        }
      } else if (slot - (s?.firstSeenSlot ?? slot) > MAX_HOLD_SLOTS) {
        // Position with no recorded entry (should not happen): age out anyway.
        exit = true;
        why = 'max-hold-no-entry';
      }
      if (exit) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        sellsSent++;
        console.error(`[bot] slot ${slot}: sell ${mint.slice(0, 8)} (${why})`);
      }
    }

    // --- 5. Entries: fresh coins with buy-dominant flow and early momentum. ---
    const freeSlots = MAX_OPEN - state.committedPositionCount();
    if (freeSlots > 0 && orders.length < 16) {
      for (const [mint, s] of stats) {
        if (orders.length >= 16) break;
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= MAX_OPEN) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (state.positions.has(mint)) continue;
        if (state.pending.size > 0) {
          let pendingBuy = false;
          for (const p of state.pending.values()) {
            if (p.order.side === 'buy' && p.order.mint === mint) {
              pendingBuy = true;
              break;
            }
          }
          if (pendingBuy) continue;
        }
        const ageBase = s.createdSlot ?? s.firstSeenSlot;
        if (slot - ageBase > FRESH_SLOTS) continue;
        if (slot < s.coolUntilSlot) continue;
        if (s.trades < MIN_TRADES) continue;
        if (s.firstPrice <= 0n || s.lastPrice <= 0n) continue;
        if (!upAtLeastPct(s.lastPrice, s.firstPrice, MIN_MOMENTUM_PCT)) continue;
        if (upAtLeastPct(s.lastPrice, s.firstPrice, MAX_MOMENTUM_PCT + 1)) continue;
        // Still rising at entry time, and still near its observed peak: don't
        // buy a coin that already rolled over from its high.
        if (s.prevPrice > 0n && s.lastPrice < s.prevPrice) continue;
        if (s.peakPrice > 0n && downAtLeastPct(s.lastPrice, s.peakPrice, NEAR_PEAK_PCT + 1)) continue;
        if (s.buyVol * BigInt(BUY_DOMINANCE_DEN) < s.sellVol * BigInt(BUY_DOMINANCE_NUM)) continue;
        if (curve.real_quote_reserves < MIN_REAL_SOL_RESERVES) continue;

        // Size: fixed size, capped by the harness per-mint cap (1% of real reserves)
        // and by free cash. Skip when the capped size is too small to matter.
        const cap = state.maxBuyLamports(mint);
        let size = BUY_SIZE_LAMPORTS;
        if (size > cap) size = cap;
        const free = state.freeCashLamports() - state.txFeeLamports();
        if (size > free) size = free;
        if (size < MIN_BUY_LAMPORTS) continue;

        orders.push({
          side: 'buy',
          mint,
          quote_lamports: size,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        buysSent++;
        console.error(`[bot] slot ${slot}: buy ${mint.slice(0, 8)} size=${size} price=${s.lastPrice}`);
      }
    }

    return orders;
  },

  onDone(state: BotState): void {
    console.error(
      `[bot] done: batches=${batchesSeen} buys=${buysSent} sells=${sellsSent} ` +
        `cash=${state.cash} positions=${state.positions.size} mintsSeen=${stats.size}`,
    );
  },
});
