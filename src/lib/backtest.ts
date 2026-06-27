// ──────────────────────────────────────────────────────────────
//  BACKTEST ENGINE — يطبّق نفس منطق المناطق/الزخم/RSI على
//  بيانات تاريخية لتقييم أداء الإشارات.
// ──────────────────────────────────────────────────────────────

import type { Kline } from "./binance";
import { computePriceMetrics, detectLiquidityZones, computeATR } from "./analysis";

export type MarketPreset = "trending" | "ranging" | "volatile" | "custom";

export interface BacktestParams {
  warmup: number;
  rrStop: number;          // ATR multiple for stop
  rrTarget: number;        // ATR multiple for tp
  maxHoldBars: number;
  minScore: number;        // |score| threshold (0..100)
  zonePct: number;         // proximity to zone (%) to consider confluence
  zoneLookback: number;    // bars used for liquidity zone detection
  rsiPeriod: number;
  rsiOverbought: number;   // damping kicks above
  rsiOversold: number;     // damping kicks below
  atrPeriod: number;
  fee: number;             // per side, fraction
  preset: MarketPreset;
}

export const DEFAULT_BT_PARAMS: BacktestParams = {
  warmup: 50,
  rrStop: 1.0,
  rrTarget: 1.8,
  maxHoldBars: 20,
  minScore: 30,
  zonePct: 0.6,
  zoneLookback: 120,
  rsiPeriod: 14,
  rsiOverbought: 72,
  rsiOversold: 28,
  atrPeriod: 14,
  fee: 0.0004,
  preset: "custom",
};

/** Recommended params per market regime. */
export const PRESETS: Record<Exclude<MarketPreset, "custom">, Partial<BacktestParams>> = {
  trending: {
    minScore: 25, rrStop: 1.2, rrTarget: 2.6, maxHoldBars: 40,
    rsiOverbought: 80, rsiOversold: 20, zonePct: 0.8,
  },
  ranging: {
    minScore: 38, rrStop: 0.8, rrTarget: 1.4, maxHoldBars: 14,
    rsiOverbought: 68, rsiOversold: 32, zonePct: 0.4,
  },
  volatile: {
    minScore: 45, rrStop: 1.6, rrTarget: 2.2, maxHoldBars: 12,
    rsiOverbought: 75, rsiOversold: 25, zonePct: 1.0, atrPeriod: 10,
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
  reason: "tp" | "sl" | "timeout";
  pnlPct: number;
  score: number;
  signalReason: string;
  confluence: boolean;
  atrUsed: number;
  nearestSupport: number | null;
  nearestResistance: number | null;
  exitReason: string;        // human-readable
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
  params: BacktestParams;
  symbol: string;
  interval: string;
  barsAnalyzed: number;
  runAt: number;
  // window timestamps for live-vs-backtest cross-reference
  fromTime: number;
  toTime: number;
}

function rsiAt(closes: number[], p: number): number {
  if (closes.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - p; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  const ag = g / p, al = l / p;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

interface Signal {
  score: number;
  reason: string;
  nearSupport: boolean;
  nearResistance: boolean;
  nearestSupport: number | null;
  nearestResistance: number | null;
  rsi: number;
  momentum: number;
  confluence: boolean;
}

function signalAt(klines: Kline[], upto: number, params: BacktestParams): Signal {
  const window = klines.slice(Math.max(0, upto - 200), upto + 1);
  if (window.length < 40) {
    return {
      score: 0, reason: "بيانات قليلة", nearSupport: false, nearResistance: false,
      nearestSupport: null, nearestResistance: null, rsi: 50, momentum: 0, confluence: false,
    };
  }
  const price = computePriceMetrics(window);
  const closes = window.map((k) => k.close);
  const rsi = rsiAt(closes, params.rsiPeriod);
  const mid = window[window.length - 1].close;
  const zones = detectLiquidityZones(window, mid, {
    lookback: Math.min(params.zoneLookback, window.length - 2),
  });

  let nearSupport = false, nearResistance = false, confluence = 0;
  let nearestSupport: number | null = null, nearestResistance: number | null = null;
  let bestSupDist = Infinity, bestResDist = Infinity;
  for (const z of zones) {
    if (Math.abs(z.distancePct) <= params.zonePct) {
      if (z.side === "below") { nearSupport = true; confluence += z.probability / 100; }
      else { nearResistance = true; confluence -= z.probability / 100; }
    }
    const d = Math.abs(z.distancePct);
    if (z.side === "below" && d < bestSupDist) { bestSupDist = d; nearestSupport = z.price; }
    if (z.side === "above" && d < bestResDist) { bestResDist = d; nearestResistance = z.price; }
  }

  const rsiBias =
    rsi >= params.rsiOverbought + 5 ? -0.4 :
    rsi >= params.rsiOverbought     ? -0.2 :
    rsi <= params.rsiOversold - 5   ?  0.4 :
    rsi <= params.rsiOversold       ?  0.2 : 0;

  const raw =
    price.momentum * 0.45 +
    Math.tanh(price.volumeTrend * 2) * 0.15 +
    Math.tanh(confluence) * 0.25 +
    rsiBias * 0.15;
  const score = Math.round(Math.tanh(raw * 1.7) * 100);

  const parts: string[] = [];
  parts.push(`زخم ${(price.momentum * 100).toFixed(0)}`);
  parts.push(`RSI ${rsi.toFixed(0)}`);
  if (nearSupport) parts.push("قرب دعم");
  if (nearResistance) parts.push("قرب مقاومة");
  if (Math.abs(confluence) > 0.2) parts.push(`تجمّع ${confluence > 0 ? "صعودي" : "هبوطي"}`);

  return {
    score, reason: parts.join(" · "),
    nearSupport, nearResistance, nearestSupport, nearestResistance,
    rsi, momentum: price.momentum,
    confluence: nearSupport || nearResistance,
  };
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
    const sig = signalAt(klines, i, params);
    const atr =
      computeATR(klines.slice(0, i + 1), params.atrPeriod) || klines[i].close * 0.003;

    let side: "long" | "short" | null = null;
    if (sig.score >= params.minScore && sig.nearSupport) side = "long";
    else if (sig.score <= -params.minScore && sig.nearResistance) side = "short";
    else if (sig.score >= params.minScore + 15) side = "long";
    else if (sig.score <= -(params.minScore + 15)) side = "short";

    if (!side) { i++; continue; }

    const entry = klines[i].close;
    const stop = side === "long" ? entry - atr * params.rrStop : entry + atr * params.rrStop;
    const tp   = side === "long" ? entry + atr * params.rrTarget : entry - atr * params.rrTarget;

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

    const exitReason =
      reason === "tp" ? `بلوغ الهدف (${(params.rrTarget).toFixed(1)}×ATR)` :
      reason === "sl" ? `ضرب الستوب (${(params.rrStop).toFixed(1)}×ATR)` :
      `انتهاء مدة الاحتفاظ (${params.maxHoldBars} شموع)`;

    trades.push({
      side, entryIdx: i, exitIdx,
      entryTime: klines[i].openTime, exitTime: klines[exitIdx].openTime,
      entry, exit: exitPrice, stop, tp, reason, pnlPct, score: sig.score,
      signalReason: sig.reason,
      confluence: sig.confluence,
      atrUsed: atr,
      nearestSupport: sig.nearestSupport,
      nearestResistance: sig.nearestResistance,
      exitReason,
    });
    i = exitIdx + 1;
  }

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
    trades, equity, wins, losses, winRate,
    totalReturnPct: running, avgTradePct,
    bestPct: n ? best : 0, worstPct: n ? worst : 0,
    maxDrawdownPct: mdd, profitFactor, expectancy,
    params, symbol, interval, barsAnalyzed: klines.length,
    runAt: Date.now(),
    fromTime: klines[0]?.openTime ?? 0,
    toTime: klines[klines.length - 1]?.openTime ?? 0,
  };
}

/** Export a backtest to CSV (KPIs header + trades rows). */
export function backtestToCSV(r: BacktestResult): string {
  const lines: string[] = [];
  lines.push(`# WhaleEye Backtest`);
  lines.push(`# Symbol,${r.symbol}`);
  lines.push(`# Interval,${r.interval}`);
  lines.push(`# RunAt,${new Date(r.runAt).toISOString()}`);
  lines.push(`# Bars,${r.barsAnalyzed}`);
  lines.push(`# Trades,${r.trades.length}`);
  lines.push(`# WinRate,${r.winRate.toFixed(2)}`);
  lines.push(`# TotalReturnPct,${r.totalReturnPct.toFixed(4)}`);
  lines.push(`# ProfitFactor,${isFinite(r.profitFactor) ? r.profitFactor.toFixed(3) : "Inf"}`);
  lines.push(`# MaxDDPct,${r.maxDrawdownPct.toFixed(4)}`);
  lines.push(`# Expectancy,${r.expectancy.toFixed(4)}`);
  lines.push(`# Params,${JSON.stringify(r.params)}`);
  lines.push("");
  const header = [
    "i","side","score","signalReason","confluence","entryTime","entry",
    "stop","tp","atr","nearestSupport","nearestResistance",
    "exitTime","exit","reason","exitReason","pnlPct",
  ];
  lines.push(header.join(","));
  r.trades.forEach((t, i) => {
    const row = [
      i + 1, t.side, t.score, esc(t.signalReason), t.confluence,
      new Date(t.entryTime).toISOString(), t.entry,
      t.stop, t.tp, t.atrUsed.toFixed(6),
      t.nearestSupport ?? "", t.nearestResistance ?? "",
      new Date(t.exitTime).toISOString(), t.exit,
      t.reason, esc(t.exitReason), t.pnlPct.toFixed(4),
    ];
    lines.push(row.join(","));
  });
  return lines.join("\n");
}
function esc(s: string) {
  if (s.includes(",") || s.includes('"')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
