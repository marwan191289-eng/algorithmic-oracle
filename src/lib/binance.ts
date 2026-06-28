// Binance public market data — no API key needed.
// REST proxied via /binance-rest  →  https://api.binance.com
// WS  proxied via /binance-ws    →  wss://stream.binance.com

export const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "ADAUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "AAVEUSDT",
] as const;

export type Symbol = (typeof SYMBOLS)[number];

export const TIMEFRAMES = [
  { label: "1د", value: "1m" },
  { label: "5د", value: "5m" },
  { label: "15د", value: "15m" },
  { label: "1س", value: "1h" },
  { label: "4س", value: "4h" },
  { label: "يومي", value: "1d" },
] as const;

export type Interval = (typeof TIMEFRAMES)[number]["value"];

export interface DepthLevel {
  price: number;
  qty: number;
}

export interface OrderBook {
  bids: DepthLevel[];
  asks: DepthLevel[];
  lastUpdateId: number;
}

export interface Ticker {
  symbol: string;
  last: number;
  change: number;
  changePct: number;
  high: number;
  low: number;
  volume: number;
  quoteVolume: number;
}

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

// ── REST helpers ───────────────────────────────────────────────────────────
// Use local proxy path so the request stays same-origin (avoids CORS / WS blocks).
function restUrl(path: string) {
  return `/binance-rest${path}`;
}

export function wsUrl(stream: string) {
  // Use relative proxy so WS goes through Vite → Binance
  return `/binance-ws/ws/${stream}`;
}

export async function fetchDepth(symbol: string, limit = 500): Promise<OrderBook> {
  const r = await fetch(restUrl(`/api/v3/depth?symbol=${symbol}&limit=${limit}`));
  if (!r.ok) throw new Error(`depth ${r.status}`);
  const j = await r.json();
  return {
    lastUpdateId: j.lastUpdateId,
    bids: (j.bids as [string, string][]).map(([p, q]) => ({ price: +p, qty: +q })),
    asks: (j.asks as [string, string][]).map(([p, q]) => ({ price: +p, qty: +q })),
  };
}

export async function fetchTicker(symbol: string): Promise<Ticker> {
  const r = await fetch(restUrl(`/api/v3/ticker/24hr?symbol=${symbol}`));
  if (!r.ok) throw new Error(`ticker ${r.status}`);
  const j = await r.json();
  return {
    symbol: j.symbol,
    last: +j.lastPrice,
    change: +j.priceChange,
    changePct: +j.priceChangePercent,
    high: +j.highPrice,
    low: +j.lowPrice,
    volume: +j.volume,
    quoteVolume: +j.quoteVolume,
  };
}

export async function fetchAllTickers(symbols: readonly string[]): Promise<Ticker[]> {
  const param = encodeURIComponent(JSON.stringify(symbols));
  const r = await fetch(restUrl(`/api/v3/ticker/24hr?symbols=${param}`));
  if (!r.ok) throw new Error(`tickers ${r.status}`);
  const arr = (await r.json()) as any[];
  return arr.map((j) => ({
    symbol: j.symbol,
    last: +j.lastPrice,
    change: +j.priceChange,
    changePct: +j.priceChangePercent,
    high: +j.highPrice,
    low: +j.lowPrice,
    volume: +j.volume,
    quoteVolume: +j.quoteVolume,
  }));
}

export async function fetchKlines(
  symbol: string,
  interval: Interval,
  limit = 200
): Promise<Kline[]> {
  const r = await fetch(
    restUrl(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`)
  );
  if (!r.ok) throw new Error(`klines ${r.status}`);
  const arr = (await r.json()) as any[][];
  return arr.map((k) => ({
    openTime: k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
    closeTime: k[6],
  }));
}

// ── Formatters ─────────────────────────────────────────────────────────────
export function fmtPrice(n: number, decimals?: number): string {
  if (!isFinite(n)) return "—";
  const d =
    decimals ??
    (n >= 1000 ? 2 : n >= 10 ? 3 : n >= 1 ? 4 : n >= 0.01 ? 5 : 6);
  return n.toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

export function fmtUsd(n: number): string {
  if (!isFinite(n)) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

export function fmtQty(n: number): string {
  if (!isFinite(n)) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(n >= 1 ? 2 : 4);
}

export function fmtPct(n: number, digits = 2): string {
  const s = n >= 0 ? "+" : "";
  return `${s}${n.toFixed(digits)}%`;
}
