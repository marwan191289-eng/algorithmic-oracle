/**
 * Cumulative Volume Delta (CVD) — Improved
 *
 * aggTrade WebSocket availability can vary by hosting/network environment.
 *
 * Previous approach (book absorption) was unreliable:
 *   prevAsk - askUsd captures ALL book changes (cancellations, repricings, etc.)
 *   NOT just filled orders → creates noise that contradicts price direction.
 *
 * New approach — Price-driven CVD with imbalance modulation:
 *   1. Base delta = price direction × notional proxy (price move as taker proxy)
 *   2. Amplify when book imbalance AGREES with price direction
 *   3. Dampen/reverse when book imbalance DISAGREES → genuine divergence signal
 *
 * This makes CVD:
 *   - Generally correlated with price (as expected)
 *   - Divergent only when real structural selling/buying pressure contradicts price
 *   - Free from market-maker quote-update noise
 */
import { useEffect, useRef, useState } from "react";
import type { OrderBook } from "@/lib/binance";

export interface CVDPoint {
  t: number;
  cvd: number;
  delta: number;
  price: number;
  buyUsd: number;
  sellUsd: number;
}

export interface CVDStats {
  cvd: number;
  delta: number;
  trend: "bullish" | "bearish" | "neutral";
  divergence: boolean;
  divergenceType: "hidden_selling" | "hidden_buying" | "none";
  points: CVDPoint[];
  imbalanceNow: number; // current book imbalance [-1, 1]
}

const DECAY = 0.9998; // soft baseline-reset: prevents indefinite drift

export function useCVD(
  book: OrderBook | null,
  mid: number,
  maxPoints = 80
): CVDStats {
  const [points, setPoints] = useState<CVDPoint[]>([]);
  const cvdRef     = useRef(0);
  const prevMid    = useRef<number | null>(null);
  const prevBid    = useRef<number>(0);
  const prevAsk    = useRef<number>(0);

  useEffect(() => {
    if (!book || !mid) return;

    // Sum top-100 levels per side
    const TOP_N = 100;
    let bidUsd = 0, askUsd = 0;
    for (const l of book.bids.slice(0, TOP_N)) bidUsd += l.qty * l.price;
    for (const l of book.asks.slice(0, TOP_N)) askUsd += l.qty * l.price;

    const totalBook = bidUsd + askUsd || 1;
    // Book imbalance: +1 = all bids, -1 = all asks
    const bookImbalance = (bidUsd - askUsd) / totalBook;

    if (prevMid.current !== null && mid !== prevMid.current) {
      const pricePct = (mid - prevMid.current) / prevMid.current;

      // Notional proxy: 1.5% of visible book depth per tick (~realistic taker volume)
      const notionalProxy = totalBook * 0.015;

      // Core CVD delta:
      //   pricePct > 0 (price up) AND bookImbalance > 0 (more bids) → strong buy
      //   pricePct > 0 (price up) AND bookImbalance < 0 (more asks) → weak buy / divergence
      //   multiplier = 1 + imbalance * 0.7 ∈ [0.3, 1.7]
      const amplifier = 1 + bookImbalance * 0.7;
      const delta = pricePct * notionalProxy * amplifier;

      // Soft decay to prevent runaway accumulation
      cvdRef.current = cvdRef.current * DECAY + delta;

      const pt: CVDPoint = {
        t: Date.now(),
        cvd: cvdRef.current,
        delta,
        price: mid,
        buyUsd:  delta >= 0 ? delta : 0,
        sellUsd: delta <  0 ? -delta : 0,
      };
      setPoints(prev => [...prev, pt].slice(-maxPoints));
    }

    prevMid.current = mid;
    prevBid.current = bidUsd;
    prevAsk.current = askUsd;
  }, [book, mid, maxPoints]);

  const cvd   = cvdRef.current;
  const delta = points.length ? points[points.length - 1].delta : 0;
  const imbalanceNow =
    prevBid.current + prevAsk.current > 0
      ? (prevBid.current - prevAsk.current) / (prevBid.current + prevAsk.current)
      : 0;

  // Trend: slope of last 10 CVD values (absolute USD threshold scales with book size)
  let trend: CVDStats["trend"] = "neutral";
  if (points.length >= 10) {
    const last10 = points.slice(-10);
    const slope  = last10[9].cvd - last10[0].cvd;
    const book_proxy = (prevBid.current + prevAsk.current) * 0.001;
    const thresh = Math.max(500, book_proxy);
    trend = slope > thresh ? "bullish" : slope < -thresh ? "bearish" : "neutral";
  }

  // Divergence: price direction vs CVD direction over last 8 ticks
  let divergence = false;
  let divergenceType: CVDStats["divergenceType"] = "none";
  if (points.length >= 8) {
    const last = points.slice(-8);
    const priceUp = last[last.length - 1].price > last[0].price;
    const cvdUp   = last[last.length - 1].cvd   > last[0].cvd;
    if (priceUp !== cvdUp) {
      divergence = true;
      divergenceType = priceUp && !cvdUp
        ? "hidden_selling"   // price up but CVD down = institutions selling into rally
        : "hidden_buying";   // price down but CVD up = institutions buying dip
    }
  }

  return { cvd, delta, trend, divergence, divergenceType, points, imbalanceNow };
}
