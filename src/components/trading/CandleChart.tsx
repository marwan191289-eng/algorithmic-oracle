import { useMemo } from "react";
import type { Kline } from "@/lib/binance";
import type { LiquidityZone, WallReport } from "@/lib/analysis";

export function CandleChart({
  klines,
  walls,
  zones,
  mid,
  height = 320,
}: {
  klines: Kline[];
  walls: WallReport;
  zones: LiquidityZone[];
  mid: number;
  height?: number;
}) {
  const data = useMemo(() => klines.slice(-100), [klines]);
  if (!data.length) return null;

  const padding = { top: 10, right: 60, bottom: 20, left: 0 };
  const width = 800; // viewBox; scales responsively
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const lows = data.map((k) => k.low);
  const highs = data.map((k) => k.high);
  const allWallPrices = [...walls.bidWalls, ...walls.askWalls].map((w) => w.price);
  const allZonePrices = zones.slice(0, 6).map((z) => z.price);
  const minP = Math.min(...lows, ...allWallPrices, ...allZonePrices, mid);
  const maxP = Math.max(...highs, ...allWallPrices, ...allZonePrices, mid);
  const range = maxP - minP || 1;
  const pad = range * 0.05;
  const lo = minP - pad;
  const hi = maxP + pad;
  const total = hi - lo;

  const y = (p: number) => padding.top + ((hi - p) / total) * innerH;
  const cw = innerW / data.length;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-auto"
      preserveAspectRatio="none"
    >
      {/* gridlines */}
      {[0.25, 0.5, 0.75].map((f) => {
        const yy = padding.top + innerH * f;
        const price = hi - total * f;
        return (
          <g key={f}>
            <line
              x1={padding.left}
              x2={padding.left + innerW}
              y1={yy}
              y2={yy}
              stroke="var(--grid)"
              strokeDasharray="2 4"
            />
            <text
              x={width - 4}
              y={yy + 3}
              fontSize="10"
              fill="var(--muted-foreground)"
              textAnchor="end"
              fontFamily="JetBrains Mono"
            >
              {price.toFixed(price > 100 ? 1 : 4)}
            </text>
          </g>
        );
      })}

      {/* liquidity zones (dashed bands) */}
      {zones.slice(0, 6).map((z, i) => {
        const yy = y(z.price);
        const isAbove = z.side === "above";
        return (
          <g key={`z-${i}`} opacity={0.6}>
            <line
              x1={padding.left}
              x2={padding.left + innerW}
              y1={yy}
              y2={yy}
              stroke={isAbove ? "var(--bear)" : "var(--bull)"}
              strokeDasharray="6 4"
              strokeWidth={1}
            />
            <rect
              x={padding.left + innerW - 56}
              y={yy - 8}
              width={52}
              height={14}
              fill={isAbove ? "var(--bear)" : "var(--bull)"}
              opacity={0.85}
              rx={2}
            />
            <text
              x={padding.left + innerW - 30}
              y={yy + 2}
              fill="white"
              fontSize="9"
              textAnchor="middle"
              fontFamily="JetBrains Mono"
            >
              {z.touches}x · {Math.round(z.probability)}%
            </text>
          </g>
        );
      })}

      {/* walls (solid) */}
      {[...walls.bidWalls.slice(0, 4), ...walls.askWalls.slice(0, 4)].map((w, i) => {
        const yy = y(w.price);
        const isBid = w.side === "bid";
        return (
          <line
            key={`w-${i}`}
            x1={padding.left}
            x2={padding.left + innerW}
            y1={yy}
            y2={yy}
            stroke={isBid ? "var(--bull)" : "var(--bear)"}
            strokeWidth={1.2}
            opacity={0.45}
          />
        );
      })}

      {/* candles */}
      {data.map((k, i) => {
        const x = padding.left + i * cw + cw / 2;
        const up = k.close >= k.open;
        const color = up ? "var(--bull)" : "var(--bear)";
        const yHigh = y(k.high);
        const yLow = y(k.low);
        const yOpen = y(k.open);
        const yClose = y(k.close);
        const bodyTop = Math.min(yOpen, yClose);
        const bodyH = Math.max(Math.abs(yClose - yOpen), 1);
        const bw = Math.max(cw * 0.7, 1.2);
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={yHigh} y2={yLow} stroke={color} strokeWidth={1} />
            <rect
              x={x - bw / 2}
              y={bodyTop}
              width={bw}
              height={bodyH}
              fill={color}
              opacity={up ? 0.9 : 0.85}
            />
          </g>
        );
      })}

      {/* mid line */}
      {(() => {
        const yy = y(mid);
        return (
          <g>
            <line
              x1={padding.left}
              x2={padding.left + innerW}
              y1={yy}
              y2={yy}
              stroke="var(--primary)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <rect
              x={width - 58}
              y={yy - 8}
              width={56}
              height={14}
              fill="var(--primary)"
              rx={2}
            />
            <text
              x={width - 30}
              y={yy + 2}
              fill="var(--primary-foreground)"
              fontSize="10"
              textAnchor="middle"
              fontFamily="JetBrains Mono"
              fontWeight="bold"
            >
              {mid.toFixed(mid > 100 ? 1 : 4)}
            </text>
          </g>
        );
      })()}
    </svg>
  );
}
