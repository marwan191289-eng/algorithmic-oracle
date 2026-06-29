/**
 * Smart Money Concepts (SMC) — structural analysis engine
 *
 * Detects institutional footprints on raw OHLCV candles:
 *
 *  • Swing Highs / Lows   — pivot points using ±N candle lookback
 *  • BOS  (Break of Structure) — price confirms trend continuation
 *  • CHOCH (Change of Character) — price signals trend reversal
 *  • FVG  (Fair Value Gap) — imbalance zones left by impulsive moves
 *  • Order Blocks          — last opposing candle before a BOS/CHOCH
 */
import type { Kline } from "@/lib/binance";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SMCDirection = "bullish" | "bearish";
export type StructureType = "BOS" | "CHOCH";
export type TrendState = "up" | "down" | "ranging";

export interface SwingPoint {
  type:      "high" | "low";
  price:     number;
  idx:       number;
  timestamp: number;
  broken:    boolean;
}

export interface StructureEvent {
  kind:      StructureType;
  direction: SMCDirection;
  /** price level that was violated */
  level:     number;
  /** candle index where the break occurred */
  idx:       number;
  timestamp: number;
}

export interface FairValueGap {
  direction: SMCDirection;
  top:       number;
  bottom:    number;
  mid:       number;
  idx:       number;       // index of the middle candle (candle that causes gap)
  timestamp: number;
  filled:    boolean;      // true if later price retraced into the gap
  fillPct:   number;       // 0-100 how much of the gap is filled
}

export interface OrderBlock {
  direction: SMCDirection;   // bullish OB = last bearish candle before bullish BOS
  top:       number;
  bottom:    number;
  mid:       number;
  idx:       number;
  timestamp: number;
  mitigated: boolean;        // price returned into OB
}

export interface SMCAnalysis {
  swings:      SwingPoint[];
  events:      StructureEvent[];
  fvgs:        FairValueGap[];
  orderBlocks: OrderBlock[];
  trend:       TrendState;
  lastBOS:     StructureEvent | null;
  lastCHOCH:   StructureEvent | null;
  /** most recent un-filled FVGs (up to 3 per side) */
  activeFVGs:  FairValueGap[];
  /** un-mitigated order blocks closest to current price */
  activeOBs:   OrderBlock[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Find pivot swing highs.  n = number of candles on each side that must be lower. */
function findSwingHighs(klines: Kline[], n = 3): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (let i = n; i < klines.length - n; i++) {
    const h = klines[i].high;
    let isPivot = true;
    for (let j = i - n; j < i; j++)      if (klines[j].high >= h) { isPivot = false; break; }
    if (!isPivot) continue;
    for (let j = i + 1; j <= i + n; j++) if (klines[j].high >= h) { isPivot = false; break; }
    if (isPivot) out.push({ type: "high", price: h, idx: i, timestamp: klines[i].openTime, broken: false });
  }
  return out;
}

/** Find pivot swing lows. */
function findSwingLows(klines: Kline[], n = 3): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (let i = n; i < klines.length - n; i++) {
    const l = klines[i].low;
    let isPivot = true;
    for (let j = i - n; j < i; j++)      if (klines[j].low <= l) { isPivot = false; break; }
    if (!isPivot) continue;
    for (let j = i + 1; j <= i + n; j++) if (klines[j].low <= l) { isPivot = false; break; }
    if (isPivot) out.push({ type: "low", price: l, idx: i, timestamp: klines[i].openTime, broken: false });
  }
  return out;
}

/** Detect Fair Value Gaps: 3-candle pattern where candle[i-2].high < candle[i].low (bullish)
 *  or candle[i-2].low > candle[i].high (bearish). */
function detectFVGs(klines: Kline[]): FairValueGap[] {
  const out: FairValueGap[] = [];
  for (let i = 2; i < klines.length; i++) {
    const prev2 = klines[i - 2];
    const curr  = klines[i];

    // Bullish FVG: gap between prev2.high and curr.low
    if (curr.low > prev2.high) {
      const top    = curr.low;
      const bottom = prev2.high;
      // Check if subsequent candles filled the gap
      let filled = false;
      let fillPct = 0;
      for (let j = i + 1; j < klines.length; j++) {
        if (klines[j].low <= bottom) { filled = true; fillPct = 100; break; }
        if (klines[j].low < top) {
          fillPct = Math.round(((top - klines[j].low) / (top - bottom)) * 100);
        }
      }
      out.push({
        direction: "bullish", top, bottom, mid: (top + bottom) / 2,
        idx: i - 1, timestamp: klines[i - 1].openTime, filled, fillPct,
      });
    }

    // Bearish FVG: gap between curr.high and prev2.low
    if (curr.high < prev2.low) {
      const top    = prev2.low;
      const bottom = curr.high;
      let filled = false;
      let fillPct = 0;
      for (let j = i + 1; j < klines.length; j++) {
        if (klines[j].high >= top) { filled = true; fillPct = 100; break; }
        if (klines[j].high > bottom) {
          fillPct = Math.round(((klines[j].high - bottom) / (top - bottom)) * 100);
        }
      }
      out.push({
        direction: "bearish", top, bottom, mid: (top + bottom) / 2,
        idx: i - 1, timestamp: klines[i - 1].openTime, filled, fillPct,
      });
    }
  }
  return out;
}

/** Find last bearish candle before bullish swing (bullish OB) or last bullish before bearish swing. */
function detectOrderBlocks(klines: Kline[], events: StructureEvent[]): OrderBlock[] {
  const out: OrderBlock[] = [];
  for (const ev of events) {
    const lookback = Math.max(0, ev.idx - 15);
    if (ev.direction === "bullish") {
      // Find last bearish candle (close < open) before the break
      for (let i = ev.idx - 1; i >= lookback; i--) {
        if (klines[i].close < klines[i].open) {
          const top    = klines[i].high;
          const bottom = klines[i].low;
          // Check mitigation: price returned into OB after break
          let mitigated = false;
          for (let j = ev.idx + 1; j < klines.length; j++) {
            if (klines[j].low <= top && klines[j].high >= bottom) { mitigated = true; break; }
          }
          out.push({
            direction: "bullish", top, bottom, mid: (top + bottom) / 2,
            idx: i, timestamp: klines[i].openTime, mitigated,
          });
          break;
        }
      }
    } else {
      // bearish BOS/CHOCH: find last bullish candle (close > open)
      for (let i = ev.idx - 1; i >= lookback; i--) {
        if (klines[i].close > klines[i].open) {
          const top    = klines[i].high;
          const bottom = klines[i].low;
          let mitigated = false;
          for (let j = ev.idx + 1; j < klines.length; j++) {
            if (klines[j].high >= bottom && klines[j].low <= top) { mitigated = true; break; }
          }
          out.push({
            direction: "bearish", top, bottom, mid: (top + bottom) / 2,
            idx: i, timestamp: klines[i].openTime, mitigated,
          });
          break;
        }
      }
    }
  }
  return out;
}

// ─── Main analysis ────────────────────────────────────────────────────────────

export function detectSMC(klines: Kline[], pivotN = 3): SMCAnalysis {
  if (klines.length < pivotN * 2 + 5) {
    return { swings: [], events: [], fvgs: [], orderBlocks: [], trend: "ranging", lastBOS: null, lastCHOCH: null, activeFVGs: [], activeOBs: [] };
  }

  const swingHighs = findSwingHighs(klines, pivotN);
  const swingLows  = findSwingLows(klines, pivotN);

  // Merge and sort all swings by index
  const allSwings: SwingPoint[] = [...swingHighs, ...swingLows].sort((a, b) => a.idx - b.idx);

  const events: StructureEvent[] = [];

  // Walk through klines and detect structure events
  // Maintain "last confirmed" swing high and low
  let lastHigh: SwingPoint | null = null;
  let lastLow:  SwingPoint | null = null;
  let trend: TrendState = "ranging";

  // Track sequence of swing points to determine trend
  let prevHigh: SwingPoint | null = null;
  let prevLow:  SwingPoint | null = null;

  for (const sw of allSwings) {
    if (sw.type === "high") {
      if (lastHigh !== null) {
        // Determine structure context — compare swing sequences
        if (trend === "up") {
          // In uptrend, closing above prior HH = BOS bullish (continuation)
          if (sw.price > lastHigh.price) {
            events.push({ kind: "BOS", direction: "bullish", level: lastHigh.price, idx: sw.idx, timestamp: sw.timestamp });
            lastHigh.broken = true;
          }
        } else if (trend === "down") {
          // In downtrend, new HH = CHOCH bullish (reversal signal)
          if (sw.price > lastHigh.price) {
            events.push({ kind: "CHOCH", direction: "bullish", level: lastHigh.price, idx: sw.idx, timestamp: sw.timestamp });
            lastHigh.broken = true;
            trend = "up";
          }
        }
        // Update trend from HL/HH pattern
        if (lastLow && prevLow && lastLow.price > prevLow.price && sw.price > lastHigh.price) {
          trend = "up"; // HH + HL confirmed
        }
        prevHigh = lastHigh;
      }
      lastHigh = sw;
    } else {
      if (lastLow !== null) {
        if (trend === "down") {
          // In downtrend, closing below prior LL = BOS bearish (continuation)
          if (sw.price < lastLow.price) {
            events.push({ kind: "BOS", direction: "bearish", level: lastLow.price, idx: sw.idx, timestamp: sw.timestamp });
            lastLow.broken = true;
          }
        } else if (trend === "up") {
          // In uptrend, new LL = CHOCH bearish (reversal signal)
          if (sw.price < lastLow.price) {
            events.push({ kind: "CHOCH", direction: "bearish", level: lastLow.price, idx: sw.idx, timestamp: sw.timestamp });
            lastLow.broken = true;
            trend = "down";
          }
        }
        // Update trend from LL/LH pattern
        if (lastHigh && prevHigh && lastHigh.price < prevHigh.price && sw.price < lastLow.price) {
          trend = "down"; // LL + LH confirmed
        }
        prevLow = lastLow;
      }
      lastLow = sw;
    }
  }

  // If no events yet, infer trend from last 3 swings
  if (events.length === 0 && allSwings.length >= 4) {
    const last4 = allSwings.slice(-4);
    const highs = last4.filter(s => s.type === "high");
    const lows  = last4.filter(s => s.type === "low");
    if (highs.length >= 2 && lows.length >= 2) {
      const hhUp = highs[highs.length - 1].price > highs[0].price;
      const hlUp = lows[lows.length - 1].price  > lows[0].price;
      if (hhUp && hlUp)   trend = "up";
      else if (!hhUp && !hlUp) trend = "down";
    }
  }

  // FVGs
  const fvgs = detectFVGs(klines);

  // Order Blocks — only for last 10 events to keep it relevant
  const recentEvents = events.slice(-10);
  const orderBlocks  = detectOrderBlocks(klines, recentEvents);

  const lastBOS   = [...events].reverse().find(e => e.kind === "BOS")   ?? null;
  const lastCHOCH = [...events].reverse().find(e => e.kind === "CHOCH") ?? null;

  // Active FVGs: unfilled, last 6 (3 per side)
  const activeFVGs = fvgs
    .filter(f => !f.filled)
    .slice(-6);

  // Active OBs: un-mitigated, last 4
  const activeOBs = orderBlocks.filter(o => !o.mitigated).slice(-4);

  return {
    swings: allSwings,
    events,
    fvgs,
    orderBlocks,
    trend,
    lastBOS,
    lastCHOCH,
    activeFVGs,
    activeOBs,
  };
}
