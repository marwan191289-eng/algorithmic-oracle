// ──────────────────────────────────────────────────────────────
//  BACKTEST ENGINE — يطبّق نفس منطق المناطق/الزخم/RSI على
//  بيانات تاريخية لتقييم أداء الإشارات.
// ──────────────────────────────────────────────────────────────

import type { Kline } from "./binance";
import {
  computePriceMetrics,
  detectLiquidityZones,
  computeATR,
} from "./analysis";

export interface BacktestParams {
  warmup: number;          // bars before first trade
  rrStop: number;          // ATR multiple for stop
  rrTarget: number;        // ATR multiple for tp
  maxHoldBars: number;     // bail after N bars
  minScore: number;        // |score| threshold (0..100)
  zonePct: number;         // proximity to zone (%) to consider confluence
  fee: number;             // per side, fraction (e.g. 0.0004 = 0.04%)
}

export const DEFAULT_BT_PARAMS: BacktestParams = {
  warmup: 50,
  rrStop: 1.0,
  rrTarget: 1.8,
  maxHoldBars: 20,
  minScore: 30,
  zonePct: 0.6,
  fee: 0.0004,
};

export interface BacktestTrade {
  side: "long" | "short";
  entryIdx: number;
  exitIdx: number;
  entryTime: number;
  exitTime: number;
  entry: number;
  exit: number;
  stop: number;
  tp: number;
  reason: "tp" | "sl" | "timeout";
  pnlPct: number;          // net of fees
  score: number;           // signal strength at entry
}

export interface BacktestResult {
  trades: BacktestTrade[];
  equity: { t: number; eq: number }[];   // cumulative pct (start = 0)
  wins: number;
  losses: number;
  winRate: number;
  totalReturnPct: number;
  avgTradePct: number;
  bestPct: number;
  worstPct: number;
  maxDrawdownPct: number;
  profitFactor: number;
  expectancy: number;
  params: BacktestParams;
  symbol: string;
  interval: string;
  barsAnalyzed: number;
}

/** Simplified "score" computable from price-action only (no live book). */
function signalAt(
  klines: Kline[],
  upto: number,
  zonePct: number
): { score: number; nearSupport: boolean; nearResistance: boolean; rsi: number; momentum: number } {
  const window = klines.slice(Math.max(0, upto - 200), upto + 1);
  if (window.length < 40) return { score: 0, nearSupport: false, nearResistance: false, rsi: 50, momentum: 0 };
  const price = computePriceMetrics(window);
  const mid = window[window.length - 1].close;
  const zones = detectLiquidityZones(window, mid, { lookback: Math.min(120, window.length - 2) });

  let nearSupport = false, nearResistance = false;
  let confluence = 0;
  for (const z of zones) {
    if (Math.abs(z.distancePct) <= zonePct) {
      if (z.side === "below") { nearSupport = true; confluence += z.probability / 100; }
      else { nearResistance = true; confluence -= z.probability / 100; }
    }
  }
  // RSI mean-reversion
  const rsiBias =
    price.rsi >= 75 ? -0.4 :
    price.rsi <= 25 ?  0.4 :
    price.rsi >= 65 ? -0.15 :
    price.rsi <= 35 ?  0.15 : 0;

  const raw =
    price.momentum * 0.45 +
    Math.tanh(price.volumeTrend * 2) * 0.15 +
    Math.tanh(confluence) * 0.25 +
    rsiBias * 0.15;
  const score = Math.round(Math.tanh(raw * 1.7) * 100);
  return { score, nearSupport, nearResistance, rsi: price.rsi, momentum: price.momentum };
}

export function runBacktest(
  klines: Kline[],
  symbol: string,
  interval: string,
  params: BacktestParams = DEFAULT_BT_PARAMS
): BacktestResult {
  const trades: BacktestTrade[] = [];
  let i = params.warmup;
  while (i < klines.length - 1) {
    const sig = signalAt(klines, i, params.zonePct);
    const atr = computeATR(klines.slice(0, i + 1), 14) || klines[i].close * 0.003;

    let side: "long" | "short" | null = null;
    if (sig.score >= params.minScore && sig.nearSupport) side = "long";
    else if (sig.score <= -params.minScore && sig.nearResistance) side = "short";
    else if (sig.score >= params.minScore + 15) side = "long";   // strong stand-alone
    else if (sig.score <= -(params.minScore + 15)) side = "short";

    if (!side) { i++; continue; }

    const entry = klines[i].close;
    const stop = side === "long" ? entry - atr * params.rrStop : entry + atr * params.rrStop;
    const tp   = side === "long" ? entry + atr * params.rrTarget : entry - atr * params.rrTarget;

    // walk forward
    let exitIdx = -1, exitPrice = entry, reason: BacktestTrade["reason"] = "timeout";
    for (let j = i + 1; j <= Math.min(klines.length - 1, i + params.maxHoldBars); j++) {
      const k = klines[j];
      if (side === "long") {
        if (k.low <= stop) { exitIdx = j; exitPrice = stop; reason = "sl"; break; }
        if (k.high >= tp)  { exitIdx = j; exitPrice = tp;   reason = "tp"; break; }
      } else {
        if (k.high >= stop) { exitIdx = j; exitPrice = stop; reason = "sl"; break; }
        if (k.low  <= tp)   { exitIdx = j; exitPrice = tp;   reason = "tp"; break; }
      }
    }
    if (exitIdx === -1) {
      exitIdx = Math.min(klines.length - 1, i + params.maxHoldBars);
      exitPrice = klines[exitIdx].close;
      reason = "timeout";
    }

    const gross = side === "long"
      ? (exitPrice - entry) / entry
      : (entry - exitPrice) / entry;
    const pnlPct = (gross - params.fee * 2) * 100;

    trades.push({
      side,
      entryIdx: i,
      exitIdx,
      entryTime: klines[i].openTime,
      exitTime: klines[exitIdx].openTime,
      entry,
      exit: exitPrice,
      stop,
      tp,
      reason,
      pnlPct,
      score: sig.score,
    });

    i = exitIdx + 1; // no overlap
  }

  // equity curve
  const equity: { t: number; eq: number }[] = [{ t: klines[params.warmup]?.openTime ?? 0, eq: 0 }];
  let running = 0, peak = 0, mdd = 0;
  let wins = 0, losses = 0, gp = 0, gl = 0, best = -Infinity, worst = Infinity, sumPct = 0;
  for (const t of trades) {
    running += t.pnlPct;
    equity.push({ t: t.exitTime, eq: running });
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > mdd) mdd = dd;
    if (t.pnlPct > 0) { wins++; gp += t.pnlPct; } else { losses++; gl += -t.pnlPct; }
    if (t.pnlPct > best)  best  = t.pnlPct;
    if (t.pnlPct < worst) worst = t.pnlPct;
    sumPct += t.pnlPct;
  }

  const n = trades.length;
  const winRate = n ? (wins / n) * 100 : 0;
  const avgTradePct = n ? sumPct / n : 0;
  const profitFactor = gl > 0 ? gp / gl : gp > 0 ? Infinity : 0;
  const avgWin = wins ? gp / wins : 0;
  const avgLoss = losses ? gl / losses : 0;
  const expectancy = (winRate / 100) * avgWin - (1 - winRate / 100) * avgLoss;

  return {
    trades,
    equity,
    wins,
    losses,
    winRate,
    totalReturnPct: running,
    avgTradePct,
    bestPct: n ? best : 0,
    worstPct: n ? worst : 0,
    maxDrawdownPct: mdd,
    profitFactor,
    expectancy,
    params,
    symbol,
    interval,
    barsAnalyzed: klines.length,
  };
}
