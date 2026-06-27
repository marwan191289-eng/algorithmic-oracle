import { useEffect, useRef, useState } from "react";
import {
  fetchDepth,
  type OrderBook,
  type Ticker,
} from "@/lib/binance";
import { useSession } from "@/lib/session-store";

// ─── live depth via @depth20@100ms (full snapshot, simpler & reliable) ───
export function useLiveDepth(symbol: string) {
  const [book, setBook] = useState<OrderBook | null>(null);
  const [connected, setConnected] = useState(false);
  const updateQualityRef = useRef(useSession.getState().updateQuality);
  const pushQualitySampleRef = useRef(useSession.getState().pushQualitySample);

  useEffect(() => {
    updateQualityRef.current = useSession.getState().updateQuality;
    pushQualitySampleRef.current = useSession.getState().pushQualitySample;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    let alive = true;
    let ws: WebSocket | null = null;
    let retryTimer: number | null = null;
    let msgTimestamps: number[] = [];
    let latSum = 0;
    let latCount = 0;
    let disconnects = 0;
    let totalMessages = 0;

    // periodic recompute (also catches "no messages = degraded")
    const tickTimer = window.setInterval(() => {
      const now = Date.now();
      msgTimestamps = msgTimestamps.filter((t) => now - t < 5000);
      const rate = msgTimestamps.length / 5;
      const avgLat = latCount ? latSum / latCount : 0;
      updateQualityRef.current(symbol, {
        symbol,
        updateRateHz: rate,
        latencyMs: avgLat,
        lastMsgAt: msgTimestamps[msgTimestamps.length - 1] ?? 0,
        totalMessages,
        disconnects,
      });
      pushQualitySampleRef.current(symbol);
    }, 1000);

    fetchDepth(symbol, 500).then((b) => alive && setBook(b)).catch(() => {});

    const connect = () => {
      ws = new WebSocket(
        `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@depth20@100ms`
      );
      ws.onopen = () => {
        if (!alive) return;
        setConnected(true);
        updateQualityRef.current(symbol, { symbol, connected: true });
      };
      ws.onclose = () => {
        if (!alive) return;
        setConnected(false);
        disconnects += 1;
        updateQualityRef.current(symbol, { symbol, connected: false, disconnects });
        retryTimer = window.setTimeout(connect, 2000);
      };
      ws.onerror = () => ws?.close();
      ws.onmessage = (e) => {
        if (!alive) return;
        try {
          const m = JSON.parse(e.data);
          const now = Date.now();
          msgTimestamps.push(now);
          totalMessages += 1;
          if (typeof m.E === "number") {
            const lat = Math.max(0, now - m.E);
            latSum += lat;
            latCount += 1;
            if (latCount > 50) {
              latSum *= 0.5;
              latCount = Math.floor(latCount * 0.5);
            }
          }
          const bids = (m.bids as [string, string][]).map(([p, q]) => ({
            price: +p,
            qty: +q,
          }));
          const asks = (m.asks as [string, string][]).map(([p, q]) => ({
            price: +p,
            qty: +q,
          }));
          setBook((prev) => {
            if (!prev) return { bids, asks, lastUpdateId: m.lastUpdateId };
            const mergedBids = mergeLevels(prev.bids, bids, "desc");
            const mergedAsks = mergeLevels(prev.asks, asks, "asc");
            return {
              bids: mergedBids,
              asks: mergedAsks,
              lastUpdateId: m.lastUpdateId,
            };
          });
        } catch {}
      };
    };

    connect();
    return () => {
      alive = false;
      window.clearInterval(tickTimer);
      if (retryTimer) window.clearTimeout(retryTimer);
      ws?.close();
    };
  }, [symbol]);

  return { book, connected };
}


function mergeLevels(
  base: { price: number; qty: number }[],
  live: { price: number; qty: number }[],
  order: "asc" | "desc"
) {
  const map = new Map<number, number>();
  for (const l of base) map.set(l.price, l.qty);
  for (const l of live) map.set(l.price, l.qty); // live overrides top
  const arr = Array.from(map, ([price, qty]) => ({ price, qty })).filter(
    (l) => l.qty > 0
  );
  arr.sort((a, b) => (order === "asc" ? a.price - b.price : b.price - a.price));
  return arr.slice(0, 500);
}

// ─── live ticker for a symbol via @ticker stream ───
export function useLiveTicker(symbol: string) {
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const lastPrice = useRef<number | null>(null);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let alive = true;
    let ws: WebSocket | null = null;
    let retryTimer: number | null = null;

    const connect = () => {
      ws = new WebSocket(
        `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@ticker`
      );
      ws.onclose = () => {
        if (!alive) return;
        retryTimer = window.setTimeout(connect, 2000);
      };
      ws.onerror = () => ws?.close();
      ws.onmessage = (e) => {
        if (!alive) return;
        try {
          const m = JSON.parse(e.data);
          const t: Ticker = {
            symbol: m.s,
            last: +m.c,
            change: +m.p,
            changePct: +m.P,
            high: +m.h,
            low: +m.l,
            volume: +m.v,
            quoteVolume: +m.q,
          };
          if (lastPrice.current != null) {
            if (t.last > lastPrice.current) setFlash("up");
            else if (t.last < lastPrice.current) setFlash("down");
            window.setTimeout(() => setFlash(null), 600);
          }
          lastPrice.current = t.last;
          setTicker(t);
        } catch {}
      };
    };

    connect();
    return () => {
      alive = false;
      if (retryTimer) window.clearTimeout(retryTimer);
      ws?.close();
    };
  }, [symbol]);

  return { ticker, flash };
}

// ─── multi-symbol tickers via combined mini-ticker stream ───
export function useLiveTickers(symbols: readonly string[]) {
  const [map, setMap] = useState<Record<string, Ticker>>({});

  useEffect(() => {
    if (typeof window === "undefined") return;
    let alive = true;
    let ws: WebSocket | null = null;
    let retryTimer: number | null = null;

    const streams = symbols.map((s) => `${s.toLowerCase()}@ticker`).join("/");

    const connect = () => {
      ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
      ws.onclose = () => {
        if (!alive) return;
        retryTimer = window.setTimeout(connect, 2000);
      };
      ws.onerror = () => ws?.close();
      ws.onmessage = (e) => {
        if (!alive) return;
        try {
          const env = JSON.parse(e.data);
          const m = env.data ?? env;
          if (!m.s) return;
          const t: Ticker = {
            symbol: m.s,
            last: +m.c,
            change: +m.p,
            changePct: +m.P,
            high: +m.h,
            low: +m.l,
            volume: +m.v,
            quoteVolume: +m.q,
          };
          setMap((prev) => ({ ...prev, [t.symbol]: t }));
        } catch {}
      };
    };

    connect();
    return () => {
      alive = false;
      if (retryTimer) window.clearTimeout(retryTimer);
      ws?.close();
    };
  }, [symbols.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  return map;
}
