// ════════════════════════════════════════════════════════════════════════
//  INSTITUTIONAL SCORE V2 — canonical composite score engine
// ════════════════════════════════════════════════════════════════════════

import type { Kline } from './binance';
import type { BookMetrics, InstitutionalVerdict, PriceWall, PriceMetrics, WallReport } from './analysis';

// ──────────────────────────────────────────────────────────────
//  6.  INSTITUTIONAL SCORE V2  —  محرّك مرجّح متعدّد الطبقات
//  Adds: proximity-weighted walls, micro-price drift, RSI mean-
//  reversion damping, signal agreement → confidence, EMA smoothing,
//  ATR-based targets/stops.
// ──────────────────────────────────────────────────────────────

export interface InstitutionalVerdictV2 extends InstitutionalVerdict {
  scoreRaw: number;            // before EMA smoothing
  compositeScore: CompositeScore;
  confidence: number;          // 0..100 — agreement between components
  agreement: number;           // count of bullish-vs-bearish components
  targets: {
    entry: number;
    stop: number;
    tp1: number;
    tp2: number;
    rr: number;                // risk:reward of tp1
    side: "long" | "short" | "none";
  };
  components: InstitutionalVerdict["components"] & {
    microDrift: number;
    proximityPressure: number;
    rsiPenalty: number;
  };
}

export interface CompositeScore {
  value: number;                // final EMA-smoothed score, [-100, 100]
  raw: number;                  // pre-EMA score, [-100, 100]
  weighted: number;             // weighted component sum before tanh
  regime: Regime;
  chopLevel: number;            // 0..1, higher means noisier market
  spreadHealth: number;         // 0..1, lower means less reliable book/price read
}

export function institutionalScoreV2(
  book: BookMetrics,
  walls: WallReport,
  price: PriceMetrics,
  klines: Kline[],
  opts: { prevScore?: number; emaAlpha?: number } = {}
): InstitutionalVerdictV2 {
  const alpha = opts.emaAlpha ?? 0.35;

  // ── 1. core components in [-1,1] ────────────────────────────────────
  // Use proximity-weighted imbalance (Python port) — near-mid orders dominate
  const bookImbalance = clamp(book.proximityImbalance, -1, 1);

  // proximity-weighted wall pressure: a wall 0.1% away counts ~10x a wall 1% away
  const wallPx = (side: "bid" | "ask", w: PriceWall[]) => {
    let sum = 0;
    for (const wl of w) {
      const dist = Math.max(0.02, Math.abs(wl.distancePct)); // floor 0.02%
      const wgt = 1 / (1 + dist * 4);
      sum += wl.usd * wgt * (side === "bid" ? 1 : -1);
    }
    return sum;
  };
  const bidPx = wallPx("bid", walls.bidWalls);
  const askPx = wallPx("ask", walls.askWalls);
  const totalPx = Math.abs(bidPx) + Math.abs(askPx) || 1;
  const proximityPressure = clamp((bidPx + askPx) / totalPx, -1, 1);

  const momentum = clamp(price.momentum, -1, 1);
  // Log-volume momentum (Python InstitutionalEngine port) used to weight volume component
  const logVolMom = clamp(price.logVolMomentum, -1, 1);
  const volumeTrend = clamp(
    (Math.tanh(price.volumeTrend * 2) + logVolMom) / 2,
    -1, 1
  );

  // micro-price drift: (microPrice - mid) / spread, capped — reveals next-tick lean
  const sp = Math.max(book.spread, book.mid * 1e-6);
  const microDrift = clamp(((book.microPrice - book.mid) / sp) * 2, -1, 1);

  // RSI mean-reversion damping — signed penalty (Python: rsiDamping * 2 - 1 clipped)
  const rsiPenalty =
    price.rsi >= 80 ? -0.4 :
    price.rsi >= 72 ? -0.2 :
    price.rsi <= 20 ?  0.4 :
    price.rsi <= 28 ?  0.2 : 0;

  const spreadHealth = clamp(1 - price.volatility * 30, 0, 1);

  // ── 2. weighted sum — regime-aware weights ────────────────────────
  const { regime, chopLevel } = detectRegime(klines);
  const W = REGIME_WEIGHTS[regime];

  const weighted =
    bookImbalance       * W.book +
    proximityPressure   * W.wall +
    momentum            * W.mom +
    rsiPenalty          * W.rsi +
    volumeTrend         * W.vol +
    microDrift          * W.micro;

  const chopDampen = 1 - chopLevel * 0.35;
  const raw = Math.tanh(weighted * 1.7) * (0.55 + 0.45 * spreadHealth) * chopDampen;
  const scoreRaw = Math.round(raw * 100);

  // ── 3. EMA smoothing — kills frame-to-frame jitter ─────────────────
  const score =
    opts.prevScore != null
      ? Math.round(opts.prevScore * (1 - alpha) + scoreRaw * alpha)
      : scoreRaw;

  // ── 4. agreement / confidence — Python formula: 60% agreement + 40% quality ─
  const signs = [
    bookImbalance, proximityPressure, momentum, microDrift, volumeTrend,
  ].map((c) => (c > 0.08 ? 1 : c < -0.08 ? -1 : 0));
  const pos = signs.filter((s) => s === 1).length;
  const neg = signs.filter((s) => s === -1).length;
  const dominant = Math.max(pos, neg);
  const total = pos + neg || 1;
  const agreementRatio = dominant / total;
  const qualityFactor = clamp(spreadHealth, 0, 1);

  // Entropy-based uncertainty: when components are scattered, confidence drops
  // even if agreement ratio looks decent. This catches "3 bullish + 2 bearish" cases.
  const vals = [bookImbalance, proximityPressure, momentum, microDrift, volumeTrend];
  const absVals = vals.map(Math.abs);
  const maxAbs = Math.max(...absVals, 0.01);
  const normalized = absVals.map(v => v / maxAbs);
  const entropy = -normalized.reduce((sum, p) => {
    const safe = Math.max(p, 0.001);
    return sum + safe * Math.log2(safe);
  }, 0);
  const maxEntropy = Math.log2(vals.length);
  const entropyFactor = 1 - clamp(entropy / maxEntropy, 0, 1); // 0 = scattered, 1 = aligned

  // False-signal filter: high chop + low agreement = don't trust it
  const trustFactor = Math.min(agreementRatio, entropyFactor) * (1 - chopLevel * 0.25);

  const confidence = Math.round(
    clamp(100 * (0.55 * trustFactor + 0.25 * qualityFactor + 0.20 * (1 - chopLevel)), 0, 100)
  );

  // ── 5. bias label ───────────────────────────────────────────────────
  let bias: InstitutionalVerdict["bias"];
  let label: string;
  if (score >= 60) {
    bias = "strong-bull";
    label = "اتجاه مؤسساتي صاعد قوي — الحيتان تتراكم";
  } else if (score >= 25) {
    bias = "bull";
    label = "ميل صعودي — ضغط الشراء يفوق البيع";
  } else if (score >= -25) {
    bias = "neutral";
    label = "توازن — منطقة تجميع أو توزيع";
  } else if (score >= -60) {
    bias = "bear";
    label = "ميل هبوطي — ضغط البيع يفوق الشراء";
  } else {
    bias = "strong-bear";
    label = "اتجاه مؤسساتي هابط قوي — الدببة مسيطرة";
  }

  const whaleSide: InstitutionalVerdict["whaleSide"] =
    walls.wallImbalance > 0.20 ? "buyers" :
    walls.wallImbalance < -0.20 ? "sellers" : "balanced";

  // ── 6. ATR-based targets ────────────────────────────────────────────
  const atr = computeATR(klines, 14) || book.mid * 0.003;
  const side: "long" | "short" | "none" =
    score >= 25 && confidence >= 55 ? "long" :
    score <= -25 && confidence >= 55 ? "short" : "none";
  const entry = book.mid;
  let stop = entry, tp1 = entry, tp2 = entry;
  if (side === "long") {
    stop = walls.strongestSupport
      ? Math.min(walls.strongestSupport.price - atr * 0.2, entry - atr * 0.8)
      : entry - atr * 1.0;
    tp1 = entry + atr * 1.5;
    tp2 = entry + atr * 3.0;
  } else if (side === "short") {
    stop = walls.strongestResistance
      ? Math.max(walls.strongestResistance.price + atr * 0.2, entry + atr * 0.8)
      : entry + atr * 1.0;
    tp1 = entry - atr * 1.5;
    tp2 = entry - atr * 3.0;
  }
  const risk = Math.abs(entry - stop) || 1;
  const reward = Math.abs(tp1 - entry);
  const rr = +(reward / risk).toFixed(2);

  // ── 7. reasoning ────────────────────────────────────────────────────
  const reasoning: string[] = [];
  reasoning.push(`اختلال القرب المرجَّح: ${pctSigned(bookImbalance * 100)} (${bookImbalance > 0 ? "شراء" : "بيع"}) — الأوامر القريبة من المنتصف تهيمن`);
  reasoning.push(`ضغط الجدران المرجَّح بالقرب: ${pctSigned(proximityPressure * 100)}`);
  reasoning.push(`انجراف السعر الميكروي: ${pctSigned(microDrift * 100)} من السبريد`);
  reasoning.push(`الزخم الخطّي للسعر: ${pctSigned(momentum * 100)}`);
  reasoning.push(`زخم الحجم اللوغاريتمي: ${pctSigned(price.logVolMomentum * 100)} — انحدار خطي على log(حجم)`);
  reasoning.push(`اتجاه الحجم المركّب: ${pctSigned(volumeTrend * 100)}`);
  reasoning.push(`RSI ${price.rsi.toFixed(1)} — تأثير mean-reversion: ${pctSigned(rsiPenalty * 100)}`);
  if (walls.strongestSupport)
    reasoning.push(`أقرب دعم قوي: ${walls.strongestSupport.price.toFixed(4)} (${fmtUsdShort(walls.strongestSupport.usd)})`);
  if (walls.strongestResistance)
    reasoning.push(`أقرب مقاومة قوية: ${walls.strongestResistance.price.toFixed(4)} (${fmtUsdShort(walls.strongestResistance.usd)})`);
  reasoning.push(`النظام: ${regime === "trending" ? "ترند واضح" : regime === "volatile" ? "متقلب مرتفع" : "متذبذب/مجموع"} — أوزان مرجحة حسب النظام`);
    reasoning.push(`الإجماع: ${dominant}/${total} مكوّن → ثقة ${confidence}% (إنتروبي + جودة + نسبة الضجيز)`);
  if (price.volatility > 0.03)
    reasoning.push(`تحذير: تقلب مرتفع ${(price.volatility * 100).toFixed(2)}%`);

  return {
    score,
    scoreRaw,
    compositeScore: {
      value: score,
      raw: scoreRaw,
      weighted,
      regime,
      chopLevel,
      spreadHealth,
    },
    bias,
    label,
    whaleSide,
    confidence,
    agreement: dominant - (total - dominant),
    targets: { entry, stop, tp1, tp2, rr, side },
    components: {
      bookImbalance,
      wallPressure: clamp(walls.wallImbalance, -1, 1),
      momentum,
      volumeTrend,
      spreadHealth,
      microDrift,
      proximityPressure,
      rsiPenalty,
    },
    reasoning,
  };
}

export function computeATR(klines: Kline[], period = 14): number {
  if (klines.length < period + 1) return 0;
  let sum = 0;
  for (let i = klines.length - period; i < klines.length; i++) {
    const k = klines[i], prev = klines[i - 1];
    sum += Math.max(k.high - k.low, Math.abs(k.high - prev.close), Math.abs(k.low - prev.close));
  }
  return sum / period;
}

// ── REGIME DETECTION ──────────────────────────────────────────────────────────────────
// Detects whether market is trending, ranging, or choppy/volatile.
// Returns regime + chopLevel (0..1, higher = more noise = dampen signals).

export type Regime = "trending" | "ranging" | "volatile";

export const REGIME_WEIGHTS: Record<Regime, { book: number; wall: number; mom: number; rsi: number; vol: number; micro: number }> = {
  // Trending: momentum + volume matter more; RSI less (follow trend)
  trending: { book: 0.22, wall: 0.18, mom: 0.22, rsi: 0.08, vol: 0.20, micro: 0.10 },
  // Ranging: mean-reversion (RSI + microDrift) matter more; momentum less
  ranging:  { book: 0.28, wall: 0.22, mom: 0.08, rsi: 0.22, vol: 0.10, micro: 0.10 },
  // Volatile: book + walls matter most; momentum suppressed (whipsaws)
  volatile: { book: 0.30, wall: 0.25, mom: 0.05, rsi: 0.10, vol: 0.20, micro: 0.10 },
};

export function detectRegime(klines: Kline[]): { regime: Regime; chopLevel: number } {
  if (klines.length < 30) return { regime: "ranging", chopLevel: 0.3 };
  const n = klines.length;
  const closes = klines.map(k => k.close);

  // ATR% — volatility proxy
  const atr = computeATR(klines, 14);
  const atrPct = atr / (closes[closes.length - 1] || 1);

  // ADX proxy — directional strength from consecutive same-direction bars
  let directional = 0;
  for (let i = n - 20; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    directional += Math.abs(d);
  }
  const totalMove = Math.abs(closes[n - 1] - closes[n - 20]);
  const adxProxy = directional > 0 ? totalMove / directional : 0; // 0 = chop, 1 = trend

  // Bollinger width proxy
  const ma20 = avg(closes.slice(-20));
  const std20 = Math.sqrt(avg(closes.slice(-20).map(c => (c - ma20) ** 2)));
  const bbWidth = (std20 / ma20) * 100;

  // Chop detection: price oscillates around mean (low net move, high total move)
  const chopLevel = clamp(1 - adxProxy, 0, 1); // 0 = clean trend, 1 = pure chop

  let regime: Regime;
  if (atrPct > 0.025 || bbWidth > 2.5) {
    regime = "volatile";
  } else if (adxProxy > 0.55 && atrPct > 0.008) {
    regime = "trending";
  } else {
    regime = "ranging";
  }

  return { regime, chopLevel };
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function avg(a: number[]) {
  return a.length ? a.reduce((s, b) => s + b, 0) / a.length : 0;
}

function pctSigned(n: number) {
  const s = n >= 0 ? "+" : "";
  return `${s}${n.toFixed(1)}%`;
}

function fmtUsdShort(n: number) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}


