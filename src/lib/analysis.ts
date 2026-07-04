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
  // v3 additions (optional — for confluence & UI labelling)
  volumeWeight?: number;      // alias of volumeScore (normalised 0..1)
  zoneType?: "equal_highs" | "equal_lows" | "swing_high" | "swing_low";
  wallConfluence?: boolean;   // true if a strong order-book wall sits inside zone
}

export function detectLiquidityZones(
  klines: Kline[],
  mid: number,
  opts: {
    lookback?:    number;
    pivotWindow?: number;
    clusterPct?:  number;
    walls?:       WallReport;   // optional: book wall confluence check
  } = {}
): LiquidityZone[] {
  if (!mid || klines.length < 10) return [];

  const lookback   = opts.lookback    ?? Math.min(klines.length, 150);
  const w          = opts.pivotWindow ?? 3;

  // ── Cluster thresholds ──────────────────────────────────────────────────
  // tightPct  : equal-highs/lows (near-identical price levels)
  // normalPct : regular swing clusters (tightened 0.25 → 0.15 for precision)
  const tightPct  = 0.10;                   // very tight — true equal levels
  const normalPct = opts.clusterPct ?? 0.15; // tighter than old 0.22/0.25

  const series    = klines.slice(-lookback);
  const n         = series.length;

  // ── Volume z-score normalisation ───────────────────────────────────────
  // Maps volume to [0,1] using robust sigmoid: 0.5 = avg, ~1 = 2 std above
  const vols  = series.map(k => k.volume);
  const vMean = vols.reduce((a, b) => a + b, 0) / vols.length || 1;
  const vSd   = Math.sqrt(vols.reduce((a, b) => a + (b - vMean) ** 2, 0) / vols.length) || 1;
  // Sigmoid-normalised: z-score → [0,1] with midpoint at mean volume
  const vNorm = (i: number): number => {
    const z = (series[i].volume - vMean) / vSd;
    return Math.max(0, Math.min(1, 1 / (1 + Math.exp(-z * 1.2))));  // steeper sigmoid
  };

  // ── Pivot detection ─────────────────────────────────────────────────────
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

  // ── Inducement detection ────────────────────────────────────────────────
  // Level is "induced" when price wicked through it then reversed — classic
  // stop-hunt pattern confirming the liquidity pool was targeted.
  const isInduced = (pivotPrice: number, pivotIdx: number, side: "above" | "below"): boolean => {
    for (let i = pivotIdx + 1; i < Math.min(n, pivotIdx + 20); i++) {
      const k = series[i];
      if (side === "above") {
        if (k.high > pivotPrice * 1.0002 && k.close < pivotPrice) return true;
      } else {
        if (k.low < pivotPrice * 0.9998 && k.close > pivotPrice) return true;
      }
    }
    return false;
  };

  // ── Wall confluence helper ──────────────────────────────────────────────
  // Returns true if any detected order-book wall sits within ±0.15% of the zone.
  const hasWallConfluence = (zoneLow: number, zoneHigh: number): boolean => {
    if (!opts.walls) return false;
    const pad = mid * 0.0015;
    const lo  = zoneLow  - pad;
    const hi  = zoneHigh + pad;
    for (const w of [...opts.walls.bidWalls, ...opts.walls.askWalls]) {
      if (w.price >= lo && w.price <= hi) return true;
    }
    return false;
  };

  // ── Clustering ──────────────────────────────────────────────────────────
  const buildClusters = (
    pts:              Pivot[],
    side:             "above" | "below",
    clusterThreshold: number
  ): LiquidityZone[] => {
    if (!pts.length) return [];
    const sorted = [...pts].sort((a, b) => a.price - b.price);
    const groups: Pivot[][] = [];
    let cur: Pivot[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      // Compare against cluster mean (not just last point) for stability
      const clusterMean = cur.reduce((s, p) => s + p.price, 0) / cur.length;
      if ((Math.abs(sorted[i].price - clusterMean) / clusterMean) * 100 <= clusterThreshold) {
        cur.push(sorted[i]);
      } else {
        groups.push(cur);
        cur = [sorted[i]];
      }
    }
    groups.push(cur);

    return groups
      .map((g): LiquidityZone | null => {
        const prices      = g.map(p => p.price);
        const meanPrice   = prices.reduce((a, b) => a + b, 0) / g.length;
        const minPrice    = Math.min(...prices);
        const maxPrice    = Math.max(...prices);
        const distancePct = ((meanPrice - mid) / mid) * 100;

        if (side === "above" && distancePct <= 0) return null;
        if (side === "below" && distancePct >= 0) return null;

        const absDist = Math.abs(distancePct);
        // Skip zones > 8% away — not actionable for near-term liquidity hunts
        if (absDist > 8) return null;

        // ── Volume-weighted scoring ──────────────────────────────────────
        // Weight each pivot's volume contribution by recency (newer = heavier)
        // so a fresh high-volume swing dominates over old low-volume pivots.
        let volWeightedSum = 0, weightSum = 0;
        for (const p of g) {
          const recencyW = 0.5 + 0.5 * (p.idx / n);   // 0.5 (oldest) → 1.0 (newest)
          volWeightedSum += p.vol * recencyW;
          weightSum      += recencyW;
        }
        const volScore = weightSum > 0 ? volWeightedSum / weightSum : 0; // 0..1

        const recency    = g.reduce((s, p) => s + p.idx, 0) / g.length / n;  // 0..1
        const equalLevel = clusterThreshold <= tightPct;
        const induced    = g.some(p => isInduced(p.price, p.idx, side));
        const wallConfl  = hasWallConfluence(minPrice, maxPrice);

        // Zone tightness: narrower cluster = price levels are more precise
        // zonePct = (maxPrice - minPrice) / meanPrice * 100  (0 = single point)
        const zonePct    = meanPrice > 0 ? (maxPrice - minPrice) / meanPrice * 100 : 0;
        const tightBonus = Math.max(0, 8 - zonePct * 20);  // max +8 for perfect single-point

        // ── Probability formula (calibrated, multi-factor) ───────────────
        // 1. Touch base — diminishing returns beyond 3 touches
        const touchBase   = g.length === 1 ? 18
                          : g.length === 2 ? 32
                          : Math.min(52, 32 + (g.length - 2) * 8);
        // 2. Proximity — quadratic decay, max +22 at 0%
        const proxBonus   = Math.max(0, 22 - absDist * absDist * 2.5);
        // 3. Recency — fresher stops are untapped and more valuable
        const recBonus    = recency * 18;
        // 4. Volume — volume-weighted score (higher vol at pivots = more stops)
        const volBonus    = volScore * 14;
        // 5. Equal-level premium — near-identical prices = dense stop cluster
        const eqBonus     = equalLevel ? 18 : 0;
        // 6. Inducement — level already swept and reversed = confirmed pool
        const indBonus    = induced ? 14 : 0;
        // 7. Wall confluence — order-book wall inside zone = institutional interest
        const wallBonus   = wallConfl ? 10 : 0;
        // 8. Tightness — tighter zone = more precise = easier to target
        const tightB      = tightBonus;
        // 9. Distance penalty — exponential beyond 3%
        const distPenalty = absDist > 3 ? (absDist - 3) ** 1.5 * 4 : 0;

        const probability = Math.min(98, Math.max(5,
          touchBase + proxBonus + recBonus + volBonus +
          eqBonus + indBonus + wallBonus + tightB - distPenalty
        ));

        // Composite strength (used for chart sizing / highlighting)
        const strength = g.length
          * (1 + volScore * 1.5)
          * (1 + recency * 0.6)
          * (induced    ? 1.35 : 1)
          * (equalLevel ? 1.20 : 1)
          * (wallConfl  ? 1.15 : 1);

        // ── Zone type classification ────────────────────────────────────
        const zoneType: LiquidityZone["zoneType"] =
          equalLevel && side === "above" ? "equal_highs"
          : equalLevel && side === "below" ? "equal_lows"
          : side === "above"              ? "swing_high"
          :                                 "swing_low";

        return {
          side,
          price:        meanPrice,
          touches:      g.length,
          distancePct,
          strength,
          probability,
          volumeScore:  volScore,
          volumeWeight: volScore,    // alias for UI consumers
          equalLevel,
          induced,
          zoneHigh:     maxPrice,
          zoneLow:      minPrice,
          zoneType,
          wallConfluence: wallConfl,
        };
      })
      .filter(Boolean) as LiquidityZone[];
  };

  // Run with both thresholds; merge overlapping zones keeping best probability
  const allZones: LiquidityZone[] = [
    ...buildClusters(highs, "above", tightPct),
    ...buildClusters(highs, "above", normalPct),
    ...buildClusters(lows,  "below", tightPct),
    ...buildClusters(lows,  "below", normalPct),
  ];

  // Deduplicate: merge zones whose prices are within 0.25% of each other
  const merged: LiquidityZone[] = [];
  for (const z of allZones) {
    const dup = merged.find(
      m => m.side === z.side && Math.abs(m.price - z.price) / z.price * 100 < 0.25
    );
    if (dup) {
      if (z.probability > dup.probability) {
        Object.assign(dup, z);
      } else {
        dup.equalLevel     = dup.equalLevel     || z.equalLevel;
        dup.induced        = dup.induced        || z.induced;
        dup.wallConfluence = dup.wallConfluence || z.wallConfluence;
        // Keep the more specific zoneType (equal > swing)
        if (z.equalLevel && !dup.equalLevel) dup.zoneType = z.zoneType;
      }
    } else {
      merged.push({ ...z });
    }
  }

  return merged
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 12);
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

export {
  institutionalScoreV2,
  computeATR,
  detectRegime,
  REGIME_WEIGHTS,
  type CompositeScore,
  type InstitutionalVerdictV2,
  type Regime,
} from './institutional-score-v2';

