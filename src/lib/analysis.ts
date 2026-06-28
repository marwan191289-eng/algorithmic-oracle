// ════════════════════════════════════════════════════════════════════════
//  THE INSTITUTIONAL ALGORITHM  —  محرّك التحليل المؤسساتي
//  Pure mathematical analysis of order book + price action.
//  No external dependencies. Deterministic. Auditable.
// ════════════════════════════════════════════════════════════════════════

import type { DepthLevel, Kline, OrderBook } from "./binance";

// ──────────────────────────────────────────────────────────────
//  1.  ORDER-BOOK METRICS
// ──────────────────────────────────────────────────────────────

export interface BookMetrics {
  mid: number;
  bestBid: number;
  bestAsk: number;
  spread: number;            // bestAsk - bestBid
  spreadPct: number;         // spread / mid * 100
  bidVol: number;            // base-asset qty in top N
  askVol: number;
  bidUsd: number;            // notional value (qty * price)
  askUsd: number;
  imbalance: number;         // (bidUsd - askUsd) / (bidUsd + askUsd) ∈ [-1, 1]
  proximityImbalance: number;// proximity-weighted imbalance (near orders count more)
  vwapBid: number;           // volume-weighted bid VWAP top N
  vwapAsk: number;
  pressureBid: number;       // Σ (qty_i * price_i / distance_i) — closer & larger = higher
  pressureAsk: number;
  microPrice: number;        // (askVol*bestBid + bidVol*bestAsk)/(bidVol+askVol)
  topN: number;
}

export function computeBookMetrics(book: OrderBook, topN = 50): BookMetrics {
  const bids = book.bids.slice(0, topN);
  const asks = book.asks.slice(0, topN);
  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;
  const mid = (bestBid + bestAsk) / 2 || 0;
  const spread = bestAsk - bestBid;

  let bidVol = 0, askVol = 0, bidUsd = 0, askUsd = 0;
  let bidPxQty = 0, askPxQty = 0;
  let pBid = 0, pAsk = 0;

  for (const b of bids) {
    bidVol += b.qty;
    bidUsd += b.qty * b.price;
    bidPxQty += b.qty * b.price;
    const dist = Math.max(mid - b.price, mid * 1e-6);
    pBid += (b.qty * b.price) / dist;
  }
  for (const a of asks) {
    askVol += a.qty;
    askUsd += a.qty * a.price;
    askPxQty += a.qty * a.price;
    const dist = Math.max(a.price - mid, mid * 1e-6);
    pAsk += (a.qty * a.price) / dist;
  }

  const totalUsd = bidUsd + askUsd || 1;
  const totalVol = bidVol + askVol || 1;

  // Proximity-weighted imbalance (Python InstitutionalEngine port):
  // Orders near the mid count much more than distant ones — weight = 1 / (distPct + 0.0001)
  let proxBid = 0, proxAsk = 0;
  for (const b of bids) {
    const distPct = Math.max(0, (mid - b.price) / (mid || 1));
    const w = 1 / (distPct + 0.0001);
    proxBid += b.qty * b.price * w;
  }
  for (const a of asks) {
    const distPct = Math.max(0, (a.price - mid) / (mid || 1));
    const w = 1 / (distPct + 0.0001);
    proxAsk += a.qty * a.price * w;
  }
  const proxTotal = proxBid + proxAsk || 1;

  return {
    mid,
    bestBid,
    bestAsk,
    spread,
    spreadPct: mid ? (spread / mid) * 100 : 0,
    bidVol,
    askVol,
    bidUsd,
    askUsd,
    imbalance: (bidUsd - askUsd) / totalUsd,
    proximityImbalance: Math.max(-1, Math.min(1, (proxBid - proxAsk) / proxTotal)),
    vwapBid: bidVol ? bidPxQty / bidVol : 0,
    vwapAsk: askVol ? askPxQty / askVol : 0,
    pressureBid: pBid,
    pressureAsk: pAsk,
    microPrice:
      (askVol * bestBid + bidVol * bestAsk) / totalVol,
    topN,
  };
}

// ──────────────────────────────────────────────────────────────
//  2.  PRICE WALLS DETECTION  (الجدران السعرية)
//  A wall = order whose USD-notional exceeds μ + k·σ of book.
// ──────────────────────────────────────────────────────────────

export interface PriceWall {
  side: "bid" | "ask";
  price: number;
  qty: number;
  usd: number;
  distancePct: number;  // distance from mid (signed by side)
  strength: number;     // z-score above mean
  rank: number;         // 1 = strongest
}

export type WallMethod = "zscore" | "percentile" | "absolute";

export interface WallReport {
  bidWalls: PriceWall[];
  askWalls: PriceWall[];
  bidWallUsd: number;
  askWallUsd: number;
  wallImbalance: number;
  strongestSupport: PriceWall | null;
  strongestResistance: PriceWall | null;
  // ── used parameters (echoed for transparency) ──
  used: {
    method: WallMethod;
    depth: number;
    zThreshold: number;
    percentile: number;
    absoluteUsd: number;
    meanUsd: number;
    sdUsd: number;
    cutoffUsd: number;     // effective notional cutoff
  };
}

export function detectWalls(
  book: OrderBook,
  mid: number,
  opts: {
    depth?: number;
    zThreshold?: number;
    percentile?: number;
    absoluteUsd?: number;
    method?: WallMethod;
    maxPerSide?: number;
  } = {}
): WallReport {
  const depth = opts.depth ?? 200;
  const z = opts.zThreshold ?? 2.5;
  const percentile = opts.percentile ?? 95;
  const absoluteUsd = opts.absoluteUsd ?? 250_000;
  const method: WallMethod = opts.method ?? "zscore";
  const maxPerSide = opts.maxPerSide ?? 8;

  // pooled stats across both sides for transparency display
  const allUsd: number[] = [];
  for (const l of book.bids.slice(0, depth)) allUsd.push(l.qty * l.price);
  for (const l of book.asks.slice(0, depth)) allUsd.push(l.qty * l.price);
  const meanAll = allUsd.length
    ? allUsd.reduce((a, b) => a + b, 0) / allUsd.length
    : 0;
  const varAll =
    allUsd.length > 1
      ? allUsd.reduce((a, b) => a + (b - meanAll) ** 2, 0) / allUsd.length
      : 0;
  const sdAll = Math.sqrt(varAll) || 1;
  const sortedAll = [...allUsd].sort((a, b) => a - b);
  const pctIdx = Math.min(
    sortedAll.length - 1,
    Math.floor((percentile / 100) * sortedAll.length)
  );
  const pctCutoff = sortedAll[pctIdx] ?? 0;
  const cutoffUsd =
    method === "zscore"
      ? meanAll + z * sdAll
      : method === "percentile"
      ? pctCutoff
      : absoluteUsd;

  const scan = (levels: DepthLevel[], side: "bid" | "ask"): PriceWall[] => {
    const slice = levels.slice(0, depth);
    if (slice.length < 5) return [];
    const usds = slice.map((l) => l.qty * l.price);
    const mean = usds.reduce((a, b) => a + b, 0) / usds.length;
    const variance =
      usds.reduce((a, b) => a + (b - mean) ** 2, 0) / usds.length;
    const sd = Math.sqrt(variance) || 1;

    const walls: PriceWall[] = [];
    slice.forEach((lvl, i) => {
      const usd = usds[i];
      let pass = false;
      let strength = 0;
      if (method === "zscore") {
        strength = (usd - mean) / sd;
        pass = strength >= z;
      } else if (method === "percentile") {
        strength = (usd - mean) / sd; // for display
        pass = usd >= pctCutoff;
      } else {
        strength = (usd - mean) / sd;
        pass = usd >= absoluteUsd;
      }
      if (pass) {
        walls.push({
          side,
          price: lvl.price,
          qty: lvl.qty,
          usd,
          distancePct: ((lvl.price - mid) / mid) * 100,
          strength,
          rank: 0,
        });
      }
    });

    walls.sort((a, b) => b.usd - a.usd);
    return walls.slice(0, maxPerSide).map((w, i) => ({ ...w, rank: i + 1 }));
  };

  const bidWalls = scan(book.bids, "bid");
  const askWalls = scan(book.asks, "ask");

  const bidWallUsd = bidWalls.reduce((s, w) => s + w.usd, 0);
  const askWallUsd = askWalls.reduce((s, w) => s + w.usd, 0);
  const total = bidWallUsd + askWallUsd || 1;

  return {
    bidWalls,
    askWalls,
    bidWallUsd,
    askWallUsd,
    wallImbalance: (bidWallUsd - askWallUsd) / total,
    strongestSupport: bidWalls[0] ?? null,
    strongestResistance: askWalls[0] ?? null,
    used: {
      method,
      depth,
      zThreshold: z,
      percentile,
      absoluteUsd,
      meanUsd: meanAll,
      sdUsd: sdAll,
      cutoffUsd,
    },
  };
}


// ──────────────────────────────────────────────────────────────
//  3.  STOP-HUNT ZONES  (مناطق صيد الأستوبات / السيولة)
//  Improved v2: swing clustering + equal-highs/lows detection
//  + volume-weighted scoring + inducement detection.
// ──────────────────────────────────────────────────────────────

export interface LiquidityZone {
  side: "above" | "below";    // above mid = sell-side liquidity (shorts' stops)
  price: number;              // cluster mean price
  touches: number;            // number of swings in cluster
  distancePct: number;        // signed: + above, − below
  strength: number;           // composite score
  probability: number;        // 0..100 — calibrated hunt probability
  // v2 additions (always present)
  volumeScore: number;        // 0..1 — avg normalised volume at pivot candles
  equalLevel: boolean;        // true = tight equal-highs / equal-lows cluster
  induced: boolean;           // true = level was swept and reversed (inducement)
  zoneHigh: number;           // cluster price range top
  zoneLow: number;            // cluster price range bottom
}

export function detectLiquidityZones(
  klines: Kline[],
  mid: number,
  opts: { lookback?: number; pivotWindow?: number; clusterPct?: number } = {}
): LiquidityZone[] {
  if (!mid || klines.length < 10) return [];

  const lookback   = opts.lookback    ?? Math.min(klines.length, 150);
  const w          = opts.pivotWindow ?? 3;
  // Two cluster thresholds: tight (equal highs/lows) and normal (swing clusters)
  const tightPct   = 0.12;   // < 0.12% = "equal" highs/lows
  const normalPct  = opts.clusterPct ?? 0.22;

  const series     = klines.slice(-lookback);
  const n          = series.length;

  // Compute volume z-scores for the series (needed for volume weighting)
  const vols       = series.map(k => k.volume);
  const vMean      = vols.reduce((a, b) => a + b, 0) / vols.length || 1;
  const vSd        = Math.sqrt(vols.reduce((a, b) => a + (b - vMean) ** 2, 0) / vols.length) || 1;
  const vNorm      = (i: number) => Math.max(0, Math.min(1, (series[i].volume - vMean) / vSd * 0.25 + 0.5));

  // Pivot detection: strict on left side, relax slightly on right (not yet confirmed)
  interface Pivot { price: number; idx: number; vol: number }
  const highs: Pivot[] = [];
  const lows:  Pivot[] = [];

  for (let i = w; i < n - w; i++) {
    const c = series[i];
    let isHigh = true, isLow = true;
    for (let k = 1; k <= w; k++) {
      if (series[i - k].high >= c.high || series[i + k].high >= c.high) isHigh = false;
      if (series[i - k].low  <= c.low  || series[i + k].low  <= c.low)  isLow  = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ price: c.high, idx: i, vol: vNorm(i) });
    if (isLow)  lows.push ({ price: c.low,  idx: i, vol: vNorm(i) });
  }

  // ── Inducement detection ───────────────────────────────────────────────
  // A level is "induced" if price briefly broke past it but then reversed.
  // Look for: swing high at level X, then a candle went above X but closed below X.
  const isInduced = (pivotPrice: number, pivotIdx: number, side: "above" | "below"): boolean => {
    for (let i = pivotIdx + 1; i < Math.min(n, pivotIdx + 20); i++) {
      const k = series[i];
      if (side === "above") {
        // Wick above pivot high but close below it → inducement
        if (k.high > pivotPrice * 1.0002 && k.close < pivotPrice) return true;
      } else {
        // Wick below pivot low but close above it → inducement
        if (k.low < pivotPrice * 0.9998 && k.close > pivotPrice) return true;
      }
    }
    return false;
  };

  // ── Clustering ─────────────────────────────────────────────────────────
  const buildClusters = (
    pts: Pivot[],
    side: "above" | "below",
    clusterThreshold: number
  ): LiquidityZone[] => {
    if (!pts.length) return [];
    const sorted = [...pts].sort((a, b) => a.price - b.price);
    const groups: Pivot[][] = [];
    let cur: Pivot[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const ref = cur[cur.length - 1].price;
      if ((Math.abs(sorted[i].price - ref) / ref) * 100 <= clusterThreshold) {
        cur.push(sorted[i]);
      } else {
        groups.push(cur);
        cur = [sorted[i]];
      }
    }
    groups.push(cur);

    return groups
      .map((g): LiquidityZone | null => {
        const prices     = g.map(p => p.price);
        const meanPrice  = prices.reduce((a, b) => a + b, 0) / g.length;
        const minPrice   = Math.min(...prices);
        const maxPrice   = Math.max(...prices);
        const distancePct = ((meanPrice - mid) / mid) * 100;

        if (side === "above" && distancePct <= 0) return null;
        if (side === "below" && distancePct >= 0) return null;

        const absDist    = Math.abs(distancePct);
        // Skip zones more than 8% away — too far to be actionable
        if (absDist > 8) return null;

        const recency    = g.reduce((s, p) => s + p.idx, 0) / g.length / n;   // 0..1
        const volScore   = g.reduce((s, p) => s + p.vol, 0) / g.length;        // 0..1
        const equalLevel = clusterThreshold === tightPct;
        const induced    = g.some(p => isInduced(p.price, p.idx, side));

        // ── Probability formula (calibrated) ──
        // Base: touches (each swing = 20% base, diminishing)
        const touchBase  = Math.min(50, g.length * 20 - (g.length > 2 ? 5 : 0));
        // Proximity bonus: closer = more likely to be hit (max 20%)
        const proxBonus  = Math.max(0, 20 - absDist * 4);
        // Recency bonus: more recent = stops are fresher (max 15%)
        const recBonus   = recency * 15;
        // Volume bonus: high-vol candles = more significant level (max 10%)
        const volBonus   = volScore * 10;
        // Equal-level bonus: multiple near-identical tops/bottoms (max 15%)
        const eqBonus    = equalLevel ? 15 : 0;
        // Inducement bonus: level was already tapped = higher re-test probability (max 12%)
        const indBonus   = induced ? 12 : 0;
        // Distance penalty: levels > 3% away discounted
        const distPenalty = Math.max(0, (absDist - 3) * 3);

        const probability = Math.min(98, Math.max(5,
          touchBase + proxBonus + recBonus + volBonus + eqBonus + indBonus - distPenalty
        ));

        const strength = g.length * (1 + volScore) * (1 + recency * 0.5) * (induced ? 1.3 : 1);

        return {
          side,
          price: meanPrice,
          touches: g.length,
          distancePct,
          strength,
          probability,
          volumeScore: volScore,
          equalLevel,
          induced,
          zoneHigh: maxPrice,
          zoneLow:  minPrice,
        };
      })
      .filter(Boolean) as LiquidityZone[];
  };

  // Run with both tight (equal highs/lows) and normal thresholds,
  // then merge duplicates (take highest probability for overlapping zones).
  const allZones: LiquidityZone[] = [
    ...buildClusters(highs, "above", tightPct),
    ...buildClusters(highs, "above", normalPct),
    ...buildClusters(lows,  "below", tightPct),
    ...buildClusters(lows,  "below", normalPct),
  ];

  // Deduplicate: merge zones whose prices are within 0.3% of each other
  const merged: LiquidityZone[] = [];
  for (const z of allZones) {
    const dup = merged.find(
      m => m.side === z.side && Math.abs(m.price - z.price) / z.price * 100 < 0.3
    );
    if (dup) {
      // Keep whichever has higher probability; absorb equal/induced flags
      if (z.probability > dup.probability) {
        Object.assign(dup, z);
      } else {
        dup.equalLevel = dup.equalLevel || z.equalLevel;
        dup.induced    = dup.induced    || z.induced;
      }
    } else {
      merged.push({ ...z });
    }
  }

  return merged
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 12); // cap at 12 zones
}

// ──────────────────────────────────────────────────────────────
//  4.  PRICE-ACTION METRICS  (zخم، تقلب، حجم)
// ──────────────────────────────────────────────────────────────

export interface PriceMetrics {
  momentum: number;       // ∈ [-1, 1] — tanh of normalized linreg slope (price)
  logVolMomentum: number; // ∈ [-1, 1] — tanh of log-linear regression slope on volume (Python port)
  volatility: number;     // ATR / price
  volumeTrend: number;    // last10vol / prev20vol − 1 ∈ ~[-1, +∞)
  rsi: number;
}

export function computePriceMetrics(klines: Kline[]): PriceMetrics {
  if (klines.length < 30)
    return { momentum: 0, logVolMomentum: 0, volatility: 0, volumeTrend: 0, rsi: 50 };
  const closes = klines.map((k) => k.close);
  const n = Math.min(50, closes.length);
  const recent = closes.slice(-n);

  // Linear regression slope on price (normalized by mean)
  const xs = recent.map((_, i) => i);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = recent.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (recent[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den ? num / den : 0;
  const momentum = Math.tanh((slope * n) / (my || 1) * 6);

  // Log-linear regression slope on volume (Python InstitutionalEngine.compute_momentum port)
  // Fits a line to log(volume) — detects log-acceleration in volume flow
  const vols = klines.map((k) => k.volume);
  const volN = Math.min(30, vols.length);
  const recentVols = vols.slice(-volN);
  const logVols = recentVols.map((v) => Math.log(v + 1e-9));
  const vxs = logVols.map((_, i) => i);
  const vmx = (volN - 1) / 2;
  const vmy = logVols.reduce((a, b) => a + b, 0) / volN;
  let vNum = 0, vDen = 0;
  for (let i = 0; i < volN; i++) {
    vNum += (vxs[i] - vmx) * (logVols[i] - vmy);
    vDen += (vxs[i] - vmx) ** 2;
  }
  const logVolSlope = vDen ? vNum / vDen : 0;
  const logVolMomentum = Math.tanh(logVolSlope * 10);

  // ATR(14)
  let atrSum = 0;
  const period = Math.min(14, klines.length - 1);
  for (let i = klines.length - period; i < klines.length; i++) {
    const k = klines[i];
    const prev = klines[i - 1];
    const tr = Math.max(
      k.high - k.low,
      Math.abs(k.high - prev.close),
      Math.abs(k.low - prev.close)
    );
    atrSum += tr;
  }
  const atr = atrSum / period;
  const volatility = atr / (closes[closes.length - 1] || 1);

  // Volume trend (short-window vs medium-window)
  const last10 = avg(vols.slice(-10));
  const prev20 = avg(vols.slice(-30, -10));
  const volumeTrend = prev20 ? last10 / prev20 - 1 : 0;

  // RSI(14)
  const rsi = computeRSI(closes, 14);

  return { momentum, logVolMomentum, volatility, volumeTrend, rsi };
}

function avg(a: number[]) {
  return a.length ? a.reduce((s, b) => s + b, 0) / a.length : 0;
}

function computeRSI(closes: number[], p = 14): number {
  if (closes.length < p + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - p; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  const ag = gains / p, al = losses / p;
  if (al === 0) return 100;
  const rs = ag / al;
  return 100 - 100 / (1 + rs);
}

// ──────────────────────────────────────────────────────────────
//  5.  INSTITUTIONAL SCORE  (الخوارزمية النهائية)
//      Composite verdict in ∈ [-100, +100].
// ──────────────────────────────────────────────────────────────

export interface InstitutionalVerdict {
  score: number;          // -100..+100
  bias: "strong-bull" | "bull" | "neutral" | "bear" | "strong-bear";
  label: string;          // Arabic verdict
  whaleSide: "buyers" | "sellers" | "balanced";
  components: {
    bookImbalance: number;
    wallPressure: number;
    momentum: number;
    volumeTrend: number;
    spreadHealth: number;
  };
  reasoning: string[];    // human-readable Arabic bullets
}

export function institutionalScore(
  book: BookMetrics,
  walls: WallReport,
  price: PriceMetrics
): InstitutionalVerdict {
  // Each input is mapped to ∈ [-1, 1] before weighted sum.
  const bookImbalance = clamp(book.imbalance, -1, 1);
  const wallPressure = clamp(walls.wallImbalance, -1, 1);
  const momentum = clamp(price.momentum, -1, 1);
  const volumeTrend = clamp(Math.tanh(price.volumeTrend * 2), -1, 1);
  // Tight spread = healthy; wide = risky. Health is unsigned, so use it to
  // amplify or dampen the absolute score.
  const spreadHealth = clamp(1 - price.volatility * 30, 0, 1);

  const weighted =
    bookImbalance * 0.30 +
    wallPressure * 0.28 +
    momentum * 0.27 +
    volumeTrend * 0.15;

  const raw = Math.tanh(weighted * 1.6) * (0.6 + 0.4 * spreadHealth);
  const score = Math.round(raw * 100);

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
    walls.wallImbalance > 0.20
      ? "buyers"
      : walls.wallImbalance < -0.20
      ? "sellers"
      : "balanced";

  const reasoning: string[] = [];
  reasoning.push(
    `اختلال دفتر الأوامر: ${pctSigned(bookImbalance * 100)} ${
      bookImbalance > 0 ? "لصالح المشترين" : "لصالح البائعين"
    }`
  );
  if (walls.strongestSupport)
    reasoning.push(
      `أقوى جدار دعم عند ${walls.strongestSupport.price.toFixed(4)} بقيمة ${fmtUsdShort(
        walls.strongestSupport.usd
      )}`
    );
  if (walls.strongestResistance)
    reasoning.push(
      `أقوى جدار مقاومة عند ${walls.strongestResistance.price.toFixed(4)} بقيمة ${fmtUsdShort(
        walls.strongestResistance.usd
      )}`
    );
  reasoning.push(
    `الزخم الاتجاهي: ${pctSigned(momentum * 100)} — ${
      momentum > 0.2 ? "صاعد" : momentum < -0.2 ? "هابط" : "محايد"
    }`
  );
  reasoning.push(
    `اتجاه الحجم: ${pctSigned(volumeTrend * 100)} مقارنة بالمتوسط`
  );
  reasoning.push(
    `RSI(14): ${price.rsi.toFixed(1)} — ${
      price.rsi > 70 ? "تشبع شرائي" : price.rsi < 30 ? "تشبع بيعي" : "طبيعي"
    }`
  );
  if (price.volatility > 0.03)
    reasoning.push(`تحذير: تقلب مرتفع (${(price.volatility * 100).toFixed(2)}%)`);

  return {
    score,
    bias,
    label,
    whaleSide,
    components: {
      bookImbalance,
      wallPressure,
      momentum,
      volumeTrend,
      spreadHealth,
    },
    reasoning,
  };
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
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

// ──────────────────────────────────────────────────────────────
//  6.  INSTITUTIONAL SCORE V2  —  محرّك مرجّح متعدّد الطبقات
//  Adds: proximity-weighted walls, micro-price drift, RSI mean-
//  reversion damping, signal agreement → confidence, EMA smoothing,
//  ATR-based targets/stops.
// ──────────────────────────────────────────────────────────────

export interface InstitutionalVerdictV2 extends InstitutionalVerdict {
  scoreRaw: number;            // before EMA smoothing
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

  // ── 2. weighted sum — matches Python weight schema (sums to 1.0) ────
  const weighted =
    bookImbalance       * 0.25 +  // proximity imbalance (Python: 0.25)
    proximityPressure   * 0.20 +  // wall proximity pressure (Python: 0.20)
    momentum            * 0.15 +  // price momentum (Python: 0.15)
    rsiPenalty          * 0.15 +  // RSI damping (Python: 0.15)
    volumeTrend         * 0.15 +  // volume direction (Python: 0.15)
    microDrift          * 0.10;   // micro drift (Python: 0.10)

  const raw = Math.tanh(weighted * 1.7) * (0.55 + 0.45 * spreadHealth);
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
  const agreementRatio = dominant / total;           // 0..1 (Python: |sum(signs)| / len)
  const qualityFactor = clamp(spreadHealth, 0, 1);   // proxy for data quality
  const confidence = Math.round(
    clamp(100 * (0.6 * agreementRatio + 0.4 * qualityFactor), 0, 100)
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
  reasoning.push(`الإجماع: ${dominant}/${total} مكوّن → ثقة ${confidence}% (60% إجماع + 40% جودة بيانات)`);
  if (price.volatility > 0.03)
    reasoning.push(`تحذير: تقلب مرتفع ${(price.volatility * 100).toFixed(2)}%`);

  return {
    score,
    scoreRaw,
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

