// ════════════════════════════════════════════════════════════════════════
//  BACKTEST ENGINE v2  —  محرك الاختبار الرجعي المؤسساتي
//  Uses IDENTICAL scoring logic to the live institutionalScoreV2 engine.
//  Synthetic order-book is reconstructed from OHLCV candle microstructure.
//  Zero look-ahead bias: each bar only sees data up to (and including) itself.
// ════════════════════════════════════════════════════════════════════════

import type { Kline } from "./binance";
import {
  computePriceMetrics,
  computeATR,
  detectRegime,
  detectLiquidityZones,
  REGIME_WEIGHTS,
  type Regime,
} from "./analysis";

export type MarketPreset = "trending" | "ranging" | "volatile" | "custom";

export interface BacktestParams {
  warmup: number;
  rrStop: number;
  rrTarget: number;
  rrTarget2: number;     // second TP (partial exit)
  partialExitPct: number; // fraction closed at TP1 (0 = disabled)
  maxHoldBars: number;
  minScore: number;
  minConfidence: number;  // minimum confidence to enter (0 = disabled)
  zonePct: number;
  zoneLookback: number;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  atrPeriod: number;
  fee: number;
  slippage: number;      // fraction of spread added to entry
  preset: MarketPreset;
}

export const DEFAULT_BT_PARAMS: BacktestParams = {
  warmup: 60,
  rrStop: 1.0,
  rrTarget: 1.8,
  rrTarget2: 3.0,
  partialExitPct: 0,
  maxHoldBars: 20,
  minScore: 30,
  minConfidence: 45,
  zonePct: 0.6,
  zoneLookback: 120,
  rsiPeriod: 14,
  rsiOverbought: 72,
  rsiOversold: 28,
  atrPeriod: 14,
  fee: 0.0004,
  slippage: 0.0002,
  preset: "custom",
};

export const PRESETS: Record<Exclude<MarketPreset, "custom">, Partial<BacktestParams>> = {
  trending: {
    minScore: 25, minConfidence: 40, rrStop: 1.2, rrTarget: 2.6, rrTarget2: 4.0,
    maxHoldBars: 40, rsiOverbought: 80, rsiOversold: 20, zonePct: 0.8,
  },
  ranging: {
    minScore: 38, minConfidence: 55, rrStop: 0.8, rrTarget: 1.4, rrTarget2: 2.0,
    maxHoldBars: 14, rsiOverbought: 68, rsiOversold: 32, zonePct: 0.4,
  },
  volatile: {
    minScore: 45, minConfidence: 60, rrStop: 1.6, rrTarget: 2.2, rrTarget2: 3.5,
    maxHoldBars: 12, rsiOverbought: 75, rsiOversold: 25, zonePct: 1.0, atrPeriod: 10,
  },
};

export function applyPreset(p: BacktestParams, preset: MarketPreset): BacktestParams {
  if (preset === "custom") return { ...p, preset };
  return { ...p, ...PRESETS[preset], preset };
}

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
  tp2: number;
  reason: "tp" | "tp2" | "sl" | "timeout";
  pnlPct: number;
  score: number;
  confidence: number;
  signalReason: string;
  confluence: boolean;
  atrUsed: number;
  nearestSupport: number | null;
  nearestResistance: number | null;
  exitReason: string;
  // V2 components
  bookImbalanceProxy: number;
  microDrift: number;
  microDriftProxy: number;
  spreadHealth: number;
  regime: Regime;
  compositeScore: number;
  momentumAtEntry: number;
  rsiAtEntry: number;
  holdBars: number;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  equity: { t: number; eq: number }[];
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
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  avgHoldBars: number;
  maxConsecWins: number;
  maxConsecLosses: number;
  longWinRate: number;
  shortWinRate: number;
  scoreDistribution: { bucket: string; count: number }[];
  params: BacktestParams;
  symbol: string;
  interval: string;
  barsAnalyzed: number;
  runAt: number;
  fromTime: number;
  toTime: number;
}

// ── Synthetic OrderBook from OHLCV microstructure ─────────────────────────
// Reconstructs approximate bid/ask pressure from candle data.
// This is the core innovation: same scoring weights as the live engine.
interface SyntheticBookMetrics {
  bookImbalance: number;      // [-1,1] candle body direction proxy
  proximityImbalance: number; // [-1,1] weighted by recency
  microDrift: number;         // [-1,1] close position within range
  wallImbalance: number;      // [-1,1] support vs resistance
  spreadProxy: number;        // relative spread estimate (low vol = tight)
  wallPressure: number;       // [-1,1] proximity-weighted wall strength
  nearestSupport: number | null;
  nearestResistance: number | null;
  confluenceScore: number;    // 0..1
}

function computeSyntheticBook(
  klines: Kline[],
  upto: number,
  params: BacktestParams
): SyntheticBookMetrics {
  const window = klines.slice(Math.max(0, upto - 200), upto + 1);
  if (window.length < 20) {
    return {
      bookImbalance: 0, proximityImbalance: 0, microDrift: 0,
      wallImbalance: 0, spreadProxy: 0.002, wallPressure: 0,
      nearestSupport: null, nearestResistance: null, confluenceScore: 0,
    };
  }

  const current = window[window.length - 1];
  const mid = (current.high + current.low) / 2;
  const range = Math.max(current.high - current.low, mid * 1e-6);

  // ── 1. Book imbalance proxy: candle body direction (weighted recent bars)
  // Bullish candle (close>open) → more buying pressure → positive
  let proxBid = 0, proxAsk = 0;
  const lookN = Math.min(20, window.length);
  for (let k = window.length - lookN; k < window.length; k++) {
    const bar = window[k];
    const barRange = Math.max(bar.high - bar.low, bar.close * 1e-6);
    const bodyDir = (bar.close - bar.open) / barRange; // [-1, 1]
    const recency = (k - (window.length - lookN)) / lookN; // 0..1
    const weight = 1 + recency * 3; // recent bars count more
    const buying = bar.volume * ((bodyDir + 1) / 2); // fraction of volume that was buying
    const selling = bar.volume * ((1 - bodyDir) / 2);
    proxBid += buying * weight;
    proxAsk += selling * weight;
  }
  const proxTotal = proxBid + proxAsk || 1;
  const bookImbalance = (proxBid - proxAsk) / proxTotal;

  // ── 2. Proximity imbalance (near mid levels matter more)
  // Use last 5 candles for short-term pressure
  let pImbalNum = 0, pImbalDen = 0;
  for (let k = window.length - 5; k < window.length; k++) {
    if (k < 0) continue;
    const bar = window[k];
    const barRange = Math.max(bar.high - bar.low, bar.close * 1e-6);
    const bodyFrac = (bar.close - bar.open) / barRange;
    const distFromMid = Math.abs(bar.close - mid) / (mid || 1);
    const w = 1 / (distFromMid + 0.0001);
    pImbalNum += bodyFrac * w * bar.volume;
    pImbalDen += w * bar.volume;
  }
  const proximityImbalance = pImbalDen > 0 ? Math.tanh(pImbalNum / pImbalDen * 3) : 0;

  // ── 3. Micro drift: close position within candle range
  // Close near high → bullish micro drift, near low → bearish
  const microDrift = (current.close - (current.high + current.low) / 2) / (range / 2);

  // ── 4. Liquidity zones as wall proxies
  const mid2 = current.close;
  const zones = detectLiquidityZones(window, mid2, {
    lookback: Math.min(params.zoneLookback, window.length - 2),
    pivotWindow: 2,
  });

  let nearestSupport: number | null = null;
  let nearestResistance: number | null = null;
  let bestSupDist = Infinity, bestResDist = Infinity;
  let supportPressure = 0, resistancePressure = 0;

  for (const z of zones) {
    const d = Math.abs(z.distancePct);
    const prob = z.probability / 100;
    const wallW = 1 / (1 + d * 4); // proximity weight (same as live engine)

    if (z.side === "below") {
      supportPressure += prob * wallW * z.touches;
      if (d < bestSupDist) { bestSupDist = d; nearestSupport = z.price; }
    } else {
      resistancePressure += prob * wallW * z.touches;
      if (d < bestResDist) { bestResDist = d; nearestResistance = z.price; }
    }
  }

  const totalWallPx = supportPressure + resistancePressure || 1;
  const wallPressure = (supportPressure - resistancePressure) / totalWallPx;
  const wallImbalance = wallPressure; // using same value

  // ── 5. Spread proxy from ATR/price volatility
  const atr14 = computeATR(window, Math.min(14, window.length - 1));
  const spreadProxy = Math.max(0.0001, atr14 / (mid || 1) * 0.1);

  // ── 6. Confluence: near support (for long) or near resistance (for short)
  const nearZonePct = params.zonePct;
  const nearSup = zones.some(z => z.side === "below" && Math.abs(z.distancePct) <= nearZonePct);
  const nearRes = zones.some(z => z.side === "above" && Math.abs(z.distancePct) <= nearZonePct);
  const confluenceScore =
    nearSup ? 0.7 + Math.min(0.3, (supportPressure / (totalWallPx || 1)) * 0.5)
    : nearRes ? 0.7 + Math.min(0.3, (resistancePressure / (totalWallPx || 1)) * 0.5)
    : 0;

  return {
    bookImbalance: Math.max(-1, Math.min(1, bookImbalance)),
    proximityImbalance: Math.max(-1, Math.min(1, proximityImbalance)),
    microDrift: Math.max(-1, Math.min(1, microDrift)),
    wallImbalance: Math.max(-1, Math.min(1, wallImbalance)),
    spreadProxy,
    wallPressure: Math.max(-1, Math.min(1, wallPressure)),
    nearestSupport,
    nearestResistance,
    confluenceScore,
  };
}

// ── Score computation — mirrors institutionalScoreV2 exactly ────────────────
interface BacktestSignal {
  score: number;
  confidence: number;
  side: "long" | "short" | null;
  reason: string;
  confluence: boolean;
  nearestSupport: number | null;
  nearestResistance: number | null;
  rsi: number;
  momentum: number;
  bookImbalanceProxy: number;
  microDrift: number;
  microDriftProxy: number;
  spreadHealth: number;
  regime: Regime;
  compositeScore: number;
  atr: number;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function signalAtV2(klines: Kline[], upto: number, params: BacktestParams): BacktestSignal {
  const window = klines.slice(Math.max(0, upto - 200), upto + 1);
  if (window.length < params.warmup) {
    return {
      score: 0, confidence: 0, side: null, reason: "warmup", confluence: false,
      nearestSupport: null, nearestResistance: null, rsi: 50, momentum: 0,
      bookImbalanceProxy: 0, microDrift: 0, microDriftProxy: 0,
      spreadHealth: 0, regime: "ranging", compositeScore: 0, atr: 0,
    };
  }

  const price = computePriceMetrics(window);
  const book = computeSyntheticBook(klines, upto, params);
  const atr = computeATR(window, params.atrPeriod) || (window[window.length - 1].close * 0.003);

  // ── Mirror institutionalScoreV2 weights exactly ──────────────────────
  const bookImbalance   = clamp(book.proximityImbalance, -1, 1);
  const wallPressure    = clamp(book.wallPressure, -1, 1);
  const momentum        = clamp(price.momentum, -1, 1);
  const logVolMom       = clamp(price.logVolMomentum, -1, 1);
  const volumeTrend     = clamp((Math.tanh(price.volumeTrend * 2) + logVolMom) / 2, -1, 1);
  const microDrift      = clamp(book.microDrift, -1, 1);
  // Use user-configured RSI thresholds (previously hardcoded to 80/72/20/28)
  const rsiOB8 = params.rsiOverbought - 8;
  const rsiOS8 = params.rsiOversold + 8;
  const rsiPenalty =
    price.rsi >= params.rsiOverbought ? -0.4 :
    price.rsi >= rsiOB8              ? -0.2 :
    price.rsi <= params.rsiOversold  ?  0.4 :
    price.rsi <= rsiOS8              ?  0.2 : 0;
  const spreadHealth = clamp(1 - price.volatility * 30, 0, 1);
  const { regime, chopLevel } = detectRegime(window);
  const W = REGIME_WEIGHTS[regime];

  const weighted =
    bookImbalance     * W.book +
    wallPressure      * W.wall +
    momentum          * W.mom +
    rsiPenalty        * W.rsi +
    volumeTrend       * W.vol +
    microDrift        * W.micro;

  const chopDampen = 1 - chopLevel * 0.35;
  const raw = Math.tanh(weighted * 1.7) * (0.55 + 0.45 * spreadHealth) * chopDampen;
  const score = Math.round(raw * 100);

  // ── Confidence (same formula as live engine) ─────────────────────────
  const signs = [bookImbalance, wallPressure, momentum, microDrift, volumeTrend]
    .map(c => (c > 0.08 ? 1 : c < -0.08 ? -1 : 0));
  const pos = signs.filter(s => s === 1).length;
  const neg = signs.filter(s => s === -1).length;
  const dominant = Math.max(pos, neg);
  const total = pos + neg || 1;
  const agreementRatio = dominant / total;
  const vals = [bookImbalance, wallPressure, momentum, microDrift, volumeTrend];
  const absVals = vals.map(Math.abs);
  const maxAbs = Math.max(...absVals, 0.01);
  const normalized = absVals.map(v => v / maxAbs);
  const entropy = -normalized.reduce((sum, p) => {
    const safe = Math.max(p, 0.001);
    return sum + safe * Math.log2(safe);
  }, 0);
  const entropyFactor = 1 - clamp(entropy / Math.log2(vals.length), 0, 1);
  const trustFactor = Math.min(agreementRatio, entropyFactor) * (1 - chopLevel * 0.25);
  const confidence = Math.round(
    clamp(100 * (0.55 * trustFactor + 0.25 * spreadHealth + 0.20 * (1 - chopLevel)), 0, 100)
  );

  // ── Entry decision ───────────────────────────────────────────────────
  const absScore = Math.abs(score);
  let side: "long" | "short" | null = null;
  if (score >= params.minScore && confidence >= params.minConfidence) side = "long";
  else if (score <= -params.minScore && confidence >= params.minConfidence) side = "short";
  // Aggressive entry: very strong signal overrides confidence requirement
  else if (score >= params.minScore + 20) side = "long";
  else if (score <= -(params.minScore + 20)) side = "short";

  // ── Hard RSI filter: block entries in extreme RSI zones (uses user params) ──
  if (side === "long"  && price.rsi >= params.rsiOverbought) side = null;
  if (side === "short" && price.rsi <= params.rsiOversold)   side = null;

  // Reason string
  const parts: string[] = [];
  parts.push(`Score ${score > 0 ? "+" : ""}${score}`);
  parts.push(`ثقة ${confidence}%`);
  parts.push(`نظام ${regime}`);
  parts.push(`زخم ${(price.momentum * 100).toFixed(0)}%`);
  parts.push(`RSI ${price.rsi.toFixed(0)}`);
  if (book.confluenceScore > 0.5) parts.push("تجمّع سيولة");
  if (Math.abs(microDrift) > 0.3) parts.push(`انجراف ${(microDrift * 100).toFixed(0)}%`);

  return {
    score, confidence, side,
    reason: parts.join(" · "),
    confluence: book.confluenceScore > 0.5,
    nearestSupport: book.nearestSupport,
    nearestResistance: book.nearestResistance,
    rsi: price.rsi,
    momentum: price.momentum,
    bookImbalanceProxy: bookImbalance,
    microDrift,
    microDriftProxy: microDrift,
    spreadHealth,
    regime,
    compositeScore: score,
    atr,
  };
}

// ── Main backtest runner ──────────────────────────────────────────────────
export function runBacktest(
  klines: Kline[],
  symbol: string,
  interval: string,
  params: BacktestParams = DEFAULT_BT_PARAMS
): BacktestResult {
  const trades: BacktestTrade[] = [];
  let i = params.warmup;

  // Pre-signals cache to avoid recomputation
  while (i < klines.length - 1) {
    const sig = signalAtV2(klines, i, params);
    if (!sig.side) { i++; continue; }

    const atr = sig.atr;
    const entryRaw = klines[i + 1].open; // enter on next bar open (no look-ahead)
    // Apply slippage: long pays more, short pays less
    const entry = sig.side === "long"
      ? entryRaw * (1 + params.slippage)
      : entryRaw * (1 - params.slippage);

    const stop = sig.side === "long"
      ? entry - atr * params.rrStop
      : entry + atr * params.rrStop;
    const tp  = sig.side === "long"
      ? entry + atr * params.rrTarget
      : entry - atr * params.rrTarget;
    const tp2 = sig.side === "long"
      ? entry + atr * params.rrTarget2
      : entry - atr * params.rrTarget2;

    let exitIdx = -1;
    let exitPrice = entry;
    let reason: BacktestTrade["reason"] = "timeout";

    for (let j = i + 1; j <= Math.min(klines.length - 1, i + params.maxHoldBars); j++) {
      const k = klines[j];
      if (sig.side === "long") {
        if (k.low <= stop)  { exitIdx = j; exitPrice = stop; reason = "sl"; break; }
        if (params.partialExitPct > 0) {
          // Partial-exit mode: skip TP1, wait for full exit at TP2
          if (k.high >= tp2) { exitIdx = j; exitPrice = tp2; reason = "tp2"; break; }
        } else {
          // Full exit at TP1 (rrTarget). TP2 only relevant with partial exits.
          if (k.high >= tp)  { exitIdx = j; exitPrice = tp;  reason = "tp"; break; }
        }
      } else {
        if (k.high >= stop) { exitIdx = j; exitPrice = stop; reason = "sl"; break; }
        if (params.partialExitPct > 0) {
          if (k.low <= tp2)  { exitIdx = j; exitPrice = tp2; reason = "tp2"; break; }
        } else {
          if (k.low <= tp)   { exitIdx = j; exitPrice = tp;  reason = "tp"; break; }
        }
      }
    }

    if (exitIdx === -1) {
      exitIdx = Math.min(klines.length - 1, i + params.maxHoldBars);
      // Exit at close of last bar (not open — avoids look-ahead)
      exitPrice = klines[exitIdx].close;
      reason = "timeout";
    }

    const gross = sig.side === "long"
      ? (exitPrice - entry) / entry
      : (entry - exitPrice) / entry;
    const pnlPct = (gross - params.fee * 2) * 100;

    const exitReason =
      reason === "tp"  ? `هدف TP1 (${params.rrTarget.toFixed(1)}×ATR)` :
      reason === "tp2" ? `هدف TP2 (${params.rrTarget2.toFixed(1)}×ATR)` :
      reason === "sl"  ? `ستوب (${params.rrStop.toFixed(1)}×ATR)` :
      `انتهاء المدة (${params.maxHoldBars} شمعة)`;

    trades.push({
      side: sig.side, entryIdx: i + 1, exitIdx,
      entryTime: klines[i + 1]?.openTime ?? klines[i].openTime,
      exitTime: klines[exitIdx].openTime,
      entry, exit: exitPrice, stop, tp, tp2, reason, pnlPct,
      score: sig.score, confidence: sig.confidence,
      signalReason: sig.reason,
      confluence: sig.confluence,
      atrUsed: atr,
      nearestSupport: sig.nearestSupport,
      nearestResistance: sig.nearestResistance,
      exitReason,
      bookImbalanceProxy: sig.bookImbalanceProxy,
      microDrift: sig.microDrift,
      microDriftProxy: sig.microDriftProxy,
      spreadHealth: sig.spreadHealth,
      regime: sig.regime,
      compositeScore: sig.compositeScore,
      momentumAtEntry: sig.momentum,
      rsiAtEntry: sig.rsi,
      holdBars: exitIdx - (i + 1),
    });

    i = exitIdx + 1; // advance past trade (no overlapping)
  }

  // ── Statistics ─────────────────────────────────────────────────────────
  const equity: { t: number; eq: number }[] = [
    { t: klines[params.warmup]?.openTime ?? 0, eq: 0 }
  ];
  let running = 0, peak = 0, mdd = 0;
  let wins = 0, losses = 0, gp = 0, gl = 0;
  let best = -Infinity, worst = Infinity, sumPct = 0;
  let longWins = 0, longTotal = 0, shortWins = 0, shortTotal = 0;
  let totalHold = 0;
  const pnls: number[] = [];
  let curWinStreak = 0, curLossStreak = 0;
  let maxConsecWins = 0, maxConsecLosses = 0;

  for (const t of trades) {
    running += t.pnlPct;
    equity.push({ t: t.exitTime, eq: running });
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > mdd) mdd = dd;

    pnls.push(t.pnlPct);
    sumPct += t.pnlPct;
    totalHold += t.holdBars;

    if (t.pnlPct > 0) {
      wins++; gp += t.pnlPct;
      curWinStreak++; curLossStreak = 0;
      maxConsecWins = Math.max(maxConsecWins, curWinStreak);
    } else {
      losses++; gl += -t.pnlPct;
      curLossStreak++; curWinStreak = 0;
      maxConsecLosses = Math.max(maxConsecLosses, curLossStreak);
    }
    if (t.pnlPct > best)  best  = t.pnlPct;
    if (t.pnlPct < worst) worst = t.pnlPct;
    if (t.side === "long") { longTotal++; if (t.pnlPct > 0) longWins++; }
    else { shortTotal++; if (t.pnlPct > 0) shortWins++; }
  }

  const n = trades.length;
  const winRate = n ? (wins / n) * 100 : 0;
  const avgTradePct = n ? sumPct / n : 0;
  const profitFactor = gl > 0 ? gp / gl : gp > 0 ? Infinity : 0;
  const avgWin = wins ? gp / wins : 0;
  const avgLoss = losses ? gl / losses : 0;
  const expectancy = (winRate / 100) * avgWin - (1 - winRate / 100) * avgLoss;
  const avgHoldBars = n ? totalHold / n : 0;

  // Sharpe Ratio (annualized from per-trade returns, assumes ~252 trading days)
  const avgR = n ? sumPct / n : 0;
  const varR = n > 1 ? pnls.reduce((s, p) => s + (p - avgR) ** 2, 0) / (n - 1) : 0;
  const stdR = Math.sqrt(varR);
  const sharpeRatio = stdR > 0 ? (avgR / stdR) * Math.sqrt(252) : 0;

  // Sortino Ratio (downside deviation only)
  const downsideVarR = n > 1 ? pnls.filter(p => p < 0).reduce((s, p) => s + p ** 2, 0) / n : 0;
  const downsideStd = Math.sqrt(downsideVarR);
  const sortinoRatio = downsideStd > 0 ? (avgR / downsideStd) * Math.sqrt(252) : 0;

  // Calmar Ratio (annualized return / max drawdown)
  const annualizedReturn = running * (252 / Math.max(1, klines.length));
  const calmarRatio = mdd > 0 ? annualizedReturn / mdd : 0;

  // Score distribution
  const buckets: Record<string, number> = {
    "30-40": 0, "40-50": 0, "50-60": 0, "60-70": 0, "70+": 0,
    "-30 → -40": 0, "-40 → -50": 0, "-50 → -60": 0, "-60 → -70": 0, "-70-": 0,
  };
  for (const t of trades) {
    const s = t.score;
    if (s >= 70) buckets["70+"]++;
    else if (s >= 60) buckets["60-70"]++;
    else if (s >= 50) buckets["50-60"]++;
    else if (s >= 40) buckets["40-50"]++;
    else if (s >= 30) buckets["30-40"]++;
    else if (s <= -70) buckets["-70-"]++;
    else if (s <= -60) buckets["-60 → -70"]++;
    else if (s <= -50) buckets["-50 → -60"]++;
    else if (s <= -40) buckets["-40 → -50"]++;
    else if (s <= -30) buckets["-30 → -40"]++;
  }
  const scoreDistribution = Object.entries(buckets)
    .filter(([, v]) => v > 0)
    .map(([bucket, count]) => ({ bucket, count }));

  return {
    trades, equity, wins, losses, winRate,
    totalReturnPct: running, avgTradePct,
    bestPct: n ? best : 0, worstPct: n ? worst : 0,
    maxDrawdownPct: mdd, profitFactor, expectancy,
    sharpeRatio: +sharpeRatio.toFixed(3),
    sortinoRatio: +sortinoRatio.toFixed(3),
    calmarRatio: +calmarRatio.toFixed(3),
    avgHoldBars: +avgHoldBars.toFixed(1),
    maxConsecWins, maxConsecLosses,
    longWinRate: longTotal ? (longWins / longTotal) * 100 : 0,
    shortWinRate: shortTotal ? (shortWins / shortTotal) * 100 : 0,
    scoreDistribution,
    params, symbol, interval, barsAnalyzed: klines.length,
    runAt: Date.now(),
    fromTime: klines[params.warmup + 1]?.openTime ?? 0,
    toTime: klines[klines.length - 1]?.openTime ?? 0,
  };
}

// ════════════════════════════════════════════════════════════════════════
//  AUTO-CALIBRATION  —  ضبط تلقائي للإعدادات من البيانات الحية
//  Detects market regime and recommends optimal BacktestParams.
// ════════════════════════════════════════════════════════════════════════

export type MarketRegime = "trending" | "ranging" | "volatile";

export interface AutoCalibResult {
  preset: MarketPreset;
  params: BacktestParams;
  regime: MarketRegime;
  reasoning: string[];
  atrPct: number;
  adxProxy: number;
  trendScore: number;
  emaDirection: "up" | "down" | "sideways";
  confidence: number; // 0-100 — how clear the regime signal is
}

/** Compute EMA over last n klines using closing prices */
function emaLast(klines: Kline[], period: number): number {
  const closes = klines.slice(-period * 3).map(k => k.close);
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

/**
 * Detects current market regime from klines and returns the optimal
 * BacktestParams preset + reasoning in Arabic.
 */
export function autoCalibrate(klines: Kline[], base: BacktestParams): AutoCalibResult {
  const n = klines.length;
  if (n < 80) {
    return {
      preset: base.preset === "custom" ? "trending" : base.preset,
      params: base,
      regime: "trending",
      reasoning: ["بيانات غير كافية للتشخيص التلقائي (< 80 شمعة)"],
      atrPct: 0, adxProxy: 0, trendScore: 0,
      emaDirection: "sideways", confidence: 0,
    };
  }

  const closes = klines.map(k => k.close);
  const price = closes[n - 1];

  // ── ATR% (volatility) ────────────────────────────────────────────────
  let atrSum = 0;
  const atrN = Math.min(14, n - 1);
  for (let i = n - atrN; i < n; i++) {
    const k = klines[i];
    const prev = klines[i - 1];
    const tr = Math.max(k.high - k.low, Math.abs(k.high - prev.close), Math.abs(k.low - prev.close));
    atrSum += tr;
  }
  const atr14 = atrSum / atrN;
  const atrPct = (atr14 / price) * 100;

  // ── EMA alignment (trend direction / slope) ─────────────────────────
  const ema20  = emaLast(klines, 20);
  const ema50  = emaLast(klines, 50);
  const ema100 = emaLast(klines, 100);

  const isUptrend   = price > ema20 && ema20 > ema50 && ema50 > ema100;
  const isDowntrend = price < ema20 && ema20 < ema50 && ema50 < ema100;
  const trendScore  = Math.abs(ema20 - ema50) / (ema50 || 1) * 100; // % separation

  const emaDirection: AutoCalibResult["emaDirection"] =
    isUptrend ? "up" : isDowntrend ? "down" : "sideways";

  // ── ADX proxy: directional close-to-close vs total bar range ────────
  const last25 = klines.slice(-25);
  const dirMoves   = last25.reduce((s, k, i) => {
    if (i === 0) return s;
    return s + Math.abs(k.close - last25[i - 1].close);
  }, 0);
  const totalRange = last25.reduce((s, k) => s + (k.high - k.low || 0.001), 0);
  const adxProxy   = totalRange > 0 ? dirMoves / totalRange : 0; // 0..1

  // ── BB width proxy (squeeze detection) ──────────────────────────────
  const last20closes = closes.slice(-20);
  const meanC = last20closes.reduce((s, v) => s + v, 0) / 20;
  const stdC  = Math.sqrt(last20closes.reduce((s, v) => s + (v - meanC) ** 2, 0) / 20);
  const bbWidthPct = (stdC / meanC) * 100;

  // ── Regime classification ────────────────────────────────────────────
  let regime: MarketRegime;
  let confidence: number;

  if (atrPct > 2.8) {
    regime = "volatile";
    confidence = Math.min(100, Math.round((atrPct - 2.8) * 30 + 60));
  } else if (adxProxy > 0.62 || trendScore > 0.35) {
    regime = "trending";
    confidence = Math.min(100, Math.round(
      (adxProxy > 0.62 ? (adxProxy - 0.62) * 150 : 0) +
      (trendScore > 0.35 ? trendScore * 40 : 0) + 50
    ));
  } else if (atrPct < 1.0 && bbWidthPct < 1.5) {
    regime = "ranging";
    confidence = Math.min(100, Math.round(70 + (1.5 - bbWidthPct) * 20));
  } else {
    regime = "ranging";
    confidence = 45;
  }

  const preset: MarketPreset = regime;
  const params = applyPreset(base, preset);

  // ── Arabic reasoning bullets ────────────────────────────────────────
  const reasoning: string[] = [
    `📊 ATR%(14) = ${atrPct.toFixed(2)}% → ${atrPct > 2.8 ? "تقلب شديد" : atrPct > 1.5 ? "تقلب متوسط" : "تقلب منخفض هادئ"}`,
    `📈 ADX proxy = ${(adxProxy * 100).toFixed(0)}% → ${adxProxy > 0.62 ? "اتجاه قوي" : adxProxy > 0.50 ? "اتجاه معتدل" : "حركة جانبية"}`,
    `🎯 EMA20 vs EMA50 = ${trendScore.toFixed(3)}% → ${
      emaDirection === "up"   ? "ترتيب صاعد (سعر > EMA20 > EMA50 > EMA100)" :
      emaDirection === "down" ? "ترتيب هابط (سعر < EMA20 < EMA50 < EMA100)" :
                                 "تقاطع، لا ترتيب واضح"
    }`,
    `📏 عرض بولنجر = ${bbWidthPct.toFixed(2)}% → ${bbWidthPct < 1.5 ? "ضيق (تراكم)" : bbWidthPct > 3 ? "واسع (تقلب)" : "طبيعي"}`,
    `✅ النظام المكتشف: ${
      regime === "trending" ? "اتجاهي — يُوصى بـ TP/SL واسع ومتابعة الترند" :
      regime === "ranging"  ? "متذبذب — يُوصى بـ TP/SL ضيق وأخذ الأرباح السريعة" :
                               "متقلب — يُوصى بـ minScore مرتفع والحذر الشديد"
    } (ثقة ${confidence}%)`,
  ];

  return { preset, params, regime, reasoning, atrPct, adxProxy, trendScore, emaDirection, confidence };
}

export function backtestToCSV(r: BacktestResult): string {
  const lines: string[] = [];
  lines.push(`# WhaleEye Institutional Backtest v2`);
  lines.push(`# Symbol,${r.symbol}`);
  lines.push(`# Interval,${r.interval}`);
  lines.push(`# RunAt,${new Date(r.runAt).toISOString()}`);
  lines.push(`# Bars,${r.barsAnalyzed}`);
  lines.push(`# Trades,${r.trades.length}`);
  lines.push(`# WinRate,${r.winRate.toFixed(2)}%`);
  lines.push(`# LongWinRate,${r.longWinRate.toFixed(2)}%`);
  lines.push(`# ShortWinRate,${r.shortWinRate.toFixed(2)}%`);
  lines.push(`# TotalReturnPct,${r.totalReturnPct.toFixed(4)}`);
  lines.push(`# ProfitFactor,${isFinite(r.profitFactor) ? r.profitFactor.toFixed(3) : "Inf"}`);
  lines.push(`# SharpeRatio,${r.sharpeRatio.toFixed(3)}`);
  lines.push(`# SortinoRatio,${r.sortinoRatio.toFixed(3)}`);
  lines.push(`# CalmarRatio,${r.calmarRatio.toFixed(3)}`);
  lines.push(`# MaxDDPct,${r.maxDrawdownPct.toFixed(4)}`);
  lines.push(`# Expectancy,${r.expectancy.toFixed(4)}`);
  lines.push(`# MaxConsecWins,${r.maxConsecWins}`);
  lines.push(`# MaxConsecLosses,${r.maxConsecLosses}`);
  lines.push(`# AvgHoldBars,${r.avgHoldBars}`);
  lines.push(`# Params,${JSON.stringify(r.params)}`);
  lines.push("");
  const header = [
    "i","side","score","confidence","signalReason","confluence",
    "bookImbalProxy","microDrift","microDriftProxy","spreadHealth","regime","compositeScore","momentum","rsiAtEntry",
    "entryTime","entry","stop","tp","tp2","atr",
    "nearestSupport","nearestResistance",
    "exitTime","exit","holdBars","reason","exitReason","pnlPct",
  ];
  lines.push(header.join(","));
  r.trades.forEach((t, i) => {
    const row = [
      i + 1, t.side, t.score, t.confidence, esc(t.signalReason), t.confluence,
      t.bookImbalanceProxy.toFixed(4), t.microDrift.toFixed(4), t.microDriftProxy.toFixed(4),
      t.spreadHealth.toFixed(4), t.regime, t.compositeScore,
      t.momentumAtEntry.toFixed(4), t.rsiAtEntry.toFixed(1),
      new Date(t.entryTime).toISOString(), t.entry.toFixed(6),
      t.stop.toFixed(6), t.tp.toFixed(6), t.tp2.toFixed(6),
      t.atrUsed.toFixed(6),
      t.nearestSupport ?? "", t.nearestResistance ?? "",
      new Date(t.exitTime).toISOString(), t.exit.toFixed(6),
      t.holdBars, t.reason, esc(t.exitReason), t.pnlPct.toFixed(4),
    ];
    lines.push(row.join(","));
  });
  return lines.join("\n");
}

function esc(s: string) {
  if (s.includes(",") || s.includes('"')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
