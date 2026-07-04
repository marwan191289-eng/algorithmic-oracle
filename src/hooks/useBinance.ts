src/hooks/useBinance.ts
import { useEffect, useRef, useState, useCallback } from "react";
import {
  fetchDepth,
  fetchTicker,
  fetchAllTickers,
  type OrderBook,
  type Ticker,
} from "@/lib/binance";
import { useSession } from "@/lib/session-store";

// ─── live depth via REST polling (1s) ────────────────────────────────────
// REST polling via a server-function proxy (works in dev and on Vercel alike).
export function useLiveDepth(symbol: string) {
  const [book, setBook] = useState<OrderBook | null>(null);
  const [connected, setConnected] = useState(false);
  const updateQualityRef = useRef(useSession.getState().updateQuality);
  const pushQualitySampleRef = useRef(useSession.getState().pushQualitySample);
  const aliveRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const msgTimestampsRef = useRef<number[]>([]);
  const disconnectsRef = useRef(0);
  const totalMsgsRef = useRef(0);

  useEffect(() => {
    updateQualityRef.current = useSession.getState().updateQuality;
    pushQualitySampleRef.current = useSession.getState().pushQualitySample;
  });

  const poll = useCallback(async () => {
    if (!aliveRef.current) return;
    try {
      const data = await fetchDepth(symbol, 100);
      if (!aliveRef.current) return;
      setBook(data);
      setConnected(true);
      const now = Date.now();
      msgTimestampsRef.current.push(now);
      totalMsgsRef.current += 1;
      // keep only last 5s
      msgTimestampsRef.current = msgTimestampsRef.current.filter(
        (t) => now - t < 5000
      );
      const rate = msgTimestampsRef.current.length / 5;
      updateQualityRef.current(symbol, {
        symbol,
        connected: true,
        updateRateHz: rate,
        latencyMs: 0,
        lastMsgAt: now,
        totalMessages: totalMsgsRef.current,
        disconnects: disconnectsRef.current,
      });
      pushQualitySampleRef.current(symbol);
    } catch {
      if (!aliveRef.current) return;
      setConnected(false);
      disconnectsRef.current += 1;
      updateQualityRef.current(symbol, {
        symbol,
        connected: false,
        disconnects: disconnectsRef.current,
      });
    }
    if (aliveRef.current) {
      timerRef.current = setTimeout(poll, 1000);
    }
  }, [symbol]);

  useEffect(() => {
    aliveRef.current = true;
    msgTimestampsRef.current = [];
    totalMsgsRef.current = 0;
    disconnectsRef.current = 0;
    setBook(null);
    setConnected(false);
    poll();
    return () => {
      aliveRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [symbol, poll]);

  return { book, connected };
}

// ─── live ticker via REST polling (2s) ────────────────────────────────────
export function useLiveTicker(symbol: string) {
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const lastPrice = useRef<number | null>(null);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const aliveRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    if (!aliveRef.current) return;
    try {
      const t = await fetchTicker(symbol);
      if (!aliveRef.current) return;
      if (lastPrice.current != null) {
        if (t.last > lastPrice.current) {
          setFlash("up");
          setTimeout(() => setFlash(null), 600);
        } else if (t.last < lastPrice.current) {
          setFlash("down");
          setTimeout(() => setFlash(null), 600);
        }
      }
      lastPrice.current = t.last;
      setTicker(t);
    } catch {
      // silent — keep last known ticker
    }
    if (aliveRef.current) {
      timerRef.current = setTimeout(poll, 2000);
    }
  }, [symbol]);

  useEffect(() => {
    aliveRef.current = true;
    lastPrice.current = null;
    setTicker(null);
    poll();
    return () => {
      aliveRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [symbol, poll]);

  return { ticker, flash };
}

// ─── multi-symbol tickers via REST polling (5s) ───────────────────────────
export function useLiveTickers(symbols: readonly string[]) {
  const [map, setMap] = useState<Record<string, Ticker>>({});
  const aliveRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const symbolsKey = symbols.join(",");

  const poll = useCallback(async () => {
    if (!aliveRef.current) return;
    try {
      const tickers = await fetchAllTickers(symbols);
      if (!aliveRef.current) return;
      const next: Record<string, Ticker> = {};
      for (const t of tickers) next[t.symbol] = t;
      setMap(next);
    } catch {
      // keep last known
    }
    if (aliveRef.current) {
      timerRef.current = setTimeout(poll, 5000);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolsKey]);

  useEffect(() => {
    aliveRef.current = true;
    poll();
    return () => {
      aliveRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [poll]);

  return map;
}
