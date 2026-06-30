/**
 * Order Flow Imbalance (OFI) — per-level tracking
 *
 * OFI measures the CHANGE in order quantity at each price level between
 * consecutive book snapshots. It reveals WHERE institutional orders are
 * being placed, reinforced, or cancelled:
 *
 *   ofi(level) = Δbid_usd  (bid qty increased → buyers entering)
 *             or Δask_usd  (ask qty increased → sellers entering, shown negative)
 *
 * Unlike raw order book depth, OFI shows the FLOW of new orders, not
 * the standing inventory — a much stronger institutional signal.
 */
import { useEffect, useRef, useState } from "react";
import type { OrderBook } from "@/lib/binance";

export interface OFILevel {
  price:   number;   // price level
  side:    "bid" | "ask";
  ofi:     number;   // delta USD (+= new bid added, −= new ask added)
  cumQty:  number;   // current standing qty at this level
  cumUsd:  number;   // current standing USD at this level
}

export interface OFISnapshot {
  levels:    OFILevel[];  // sorted by price desc (bids first, then asks)
  netOFI:    number;      // Σ bid_ofi − Σ ask_ofi (positive = net buy pressure)
  bidOFI:    number;      // total positive flow on bid side
  askOFI:    number;      // total positive flow on ask side
  maxAbsOFI: number;      // for normalising bar widths
  ts:        number;
}

export interface OFIStats {
  current:    OFISnapshot | null;
  history:    OFISnapshot[];    // last N snapshots for rolling chart
  rollingNet: number;           // rolling 10-tick net OFI
  pressure:   "buy" | "sell" | "neutral";
}

const LEVELS  = 16;    // levels per side
const HISTORY = 30;    // snapshots to keep

export function useOFI(book: OrderBook | null, mid: number): OFIStats {
  const [stats, setStats] = useState<OFIStats>({
    current: null, history: [], rollingNet: 0, pressure: "neutral",
  });

  // Store prev book as Map<price→usd> for fast lookup
  const prevBids = useRef<Map<number, number>>(new Map());
  const prevAsks = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    if (!book || !mid) return;

    const now = Date.now();

    // Build current maps
    const curBids = new Map<number, number>();
    const curAsks = new Map<number, number>();
    for (const l of book.bids.slice(0, LEVELS * 2)) curBids.set(l.price, l.qty * l.price);
    for (const l of book.asks.slice(0, LEVELS * 2)) curAsks.set(l.price, l.qty * l.price);

    // Compute OFI per level
    const levels: OFILevel[] = [];
    let bidOFI = 0, askOFI = 0;

    // Bid levels (closest to mid first)
    const bidLevels = book.bids.slice(0, LEVELS);
    for (const l of bidLevels) {
      const curUsd  = l.qty * l.price;
      const prevUsd = prevBids.current.get(l.price) ?? 0;
      const ofi     = curUsd - prevUsd;  // positive = new bid placed/reinforced
      if (Math.abs(ofi) > 10) {          // filter micro-noise < $10
        bidOFI += Math.max(0, ofi);
        levels.push({ price: l.price, side: "bid", ofi, cumQty: l.qty, cumUsd: curUsd });
      }
    }

    // Ask levels (closest to mid first)
    const askLevels = book.asks.slice(0, LEVELS);
    for (const l of askLevels) {
      const curUsd  = l.qty * l.price;
      const prevUsd = prevAsks.current.get(l.price) ?? 0;
      const ofi     = curUsd - prevUsd;  // positive = new ask placed, shown as negative
      if (Math.abs(ofi) > 10) {
        askOFI += Math.max(0, ofi);
        levels.push({ price: l.price, side: "ask", ofi: -ofi, cumQty: l.qty, cumUsd: curUsd });
      }
    }

    // Sort: asks desc price (above mid) → bids desc price (below mid)
    levels.sort((a, b) => b.price - a.price);

    const maxAbsOFI = Math.max(...levels.map(l => Math.abs(l.ofi)), 1);
    const netOFI    = bidOFI - askOFI;

    const snap: OFISnapshot = { levels, netOFI, bidOFI, askOFI, maxAbsOFI, ts: now };

    // Only update state if there's meaningful flow (avoid blank updates)
    if (levels.length > 0) {
      setStats(prev => {
        const history = [...prev.history, snap].slice(-HISTORY);
        const rollingNet = history.slice(-10).reduce((s, h) => s + h.netOFI, 0);
        const pressure: OFIStats["pressure"] =
          rollingNet > 5000  ? "buy"
          : rollingNet < -5000 ? "sell"
          : "neutral";
        return { current: snap, history, rollingNet, pressure };
      });
    }

    // Advance prev references
    prevBids.current = curBids;
    prevAsks.current = curAsks;
  }, [book, mid]);

  return stats;
}
