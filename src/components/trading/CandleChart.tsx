import { useMemo, useState, useCallback } from "react";
import type { Kline } from "@/lib/binance";
import type { LiquidityZone, WallReport } from "@/lib/analysis";

export function CandleChart({
  klines,
  walls,
  zones,
  mid,
  height = 380,
}: {
  klines: Kline[];
  walls: WallReport;
  zones: LiquidityZone[];
  mid: number;
  height?: number;
}) {
  const [hover, setHover] = useState<{ x: number; price: number; candle?: Kline } | null>(null);

  const data = useMemo(() => klines.slice(-120), [klines]);
  const maxVol = useMemo(() => Math.max(...data.map(k => k.volume), 1), [data]);

  if (!data.length) return null;

  const volH = 48;           // volume bar area height
  const padding = { top: 14, right: 64, bottom: volH + 6, left: 0 };
  const width = 900;
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const lows = data.map((k) => k.low);
  const highs = data.map((k) => k.high);
  const allWallPrices = [...walls.bidWalls, ...walls.askWalls].map((w) => w.price);
  const allZonePrices = zones.slice(0, 6).map((z) => z.price);
  const minP = Math.min(...lows, ...allWallPrices, ...allZonePrices, mid);
  const maxP = Math.max(...highs, ...allWallPrices, ...allZonePrices, mid);
  const range = maxP - minP || 1;
  const pad = range * 0.04;
  const lo = minP - pad;
  const hi = maxP + pad;
  const total = hi - lo;

  const y = (p: number) => padding.top + ((hi - p) / total) * innerH;
  const cw = innerW / data.length;

  const handleMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const idx = Math.round((x - padding.left - cw / 2) / cw);
    const clamped = Math.max(0, Math.min(data.length - 1, idx));
    const price = hi - ((x - padding.left) / innerW) * total;
    setHover({ x, price, candle: data[clamped] });
  }, [data, cw, innerW, hi, lo, total]);

  const handleLeave = useCallback(() => setHover(null), []);

  // Price grid at 0%, 25%, 50%, 75%, 100%
  const gridPrices = [0, 0.25, 0.5, 0.75, 1.0];

  // Wall max for opacity scaling
  const wallMaxUsd = Math.max(
    ...walls.bidWalls.map(w => w.usd),
    ...walls.askWalls.map(w => w.usd),
    1
  );

  return (
    <div className="relative select-none">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto cursor-crosshair"
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
      >
        {/* Background */}
        <rect x={0} y={0} width={width} height={height} fill="transparent" />

        {/* Grid lines + price labels */}
        {gridPrices.map((f) => {
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
                strokeDasharray={f === 0.5 ? "3 3" : "1 3"}
                opacity={f === 0.5 ? 0.5 : 0.25}
              />
              <text
                x={width - 4}
                y={yy + 3.5}
                fontSize="9.5"
                fill="var(--muted-foreground)"
                textAnchor="end"
                fontFamily="JetBrains Mono"
              >
                {price > 100 ? price.toFixed(1) : price.toFixed(4)}
              </text>
            </g>
          );
        })}

        {/* Liquidity zones as shaded bands (zoneHigh → zoneLow) */}
        {zones.slice(0, 5).map((z, i) => {
          const topY = y(z.zoneHigh);
          const botY = y(z.zoneLow);
          const h = Math.max(botY - topY, 1);
          const isAbove = z.side === "above";
          const alpha = 0.05 + (z.probability / 100) * 0.12;
          return (
            <g key={`zb-${i}`}>
              <rect
                x={padding.left}
                y={topY}
                width={innerW}
                height={h}
                fill={isAbove ? "var(--bear)" : "var(--bull)"}
                opacity={alpha}
              />
              <line
                x1={padding.left}
                x2={padding.left + innerW}
                y1={topY}
                y2={topY}
                stroke={isAbove ? "var(--bear)" : "var(--bull)"}
                strokeDasharray="4 3"
                strokeWidth={0.8}
                opacity={0.45}
              />
              <line
                x1={padding.left}
                x2={padding.left + innerW}
                y1={botY}
                y2={botY}
                stroke={isAbove ? "var(--bear)" : "var(--bull)"}
                strokeDasharray="4 3"
                strokeWidth={0.8}
                opacity={0.45}
              />
            </g>
          );
        })}

        {/* Walls as horizontal bars with depth shading */}
        {[...walls.bidWalls.slice(0, 4), ...walls.askWalls.slice(0, 4)].map((w, i) => {
          const yy = y(w.price);
          const isBid = w.side === "bid";
          const opacity = 0.12 + (w.usd / wallMaxUsd) * 0.35;
          return (
            <g key={`wb-${i}`}>
              <line
                x1={padding.left}
                x2={padding.left + innerW}
                y1={yy}
                y2={yy}
                stroke={isBid ? "var(--bull)" : "var(--bear)"}
                strokeWidth={1.5}
                opacity={opacity}
              />
              {/* Small dot at right edge */}
              <circle
                cx={padding.left + innerW - 4}
                cy={yy}
                r={2.5}
                fill={isBid ? "var(--bull)" : "var(--bear)"}
                opacity={0.7}
              />
            </g>
          );
        })}

        {/* Candles */}
        {data.map((k, i) => {
          const x = padding.left + i * cw + cw / 2;
          const up = k.close >= k.open;
          const bodyTop = Math.min(y(k.open), y(k.close));
          const bodyBot = Math.max(y(k.open), y(k.close));
          const bodyH = Math.max(bodyBot - bodyTop, 0.8);
          const bw = Math.max(cw * 0.6, 1);
          const isHovered = hover?.candle === k;

          return (
            <g key={i}>
              {/* Wick */}
              <line
                x1={x}
                x2={x}
                y1={y(k.high)}
                y2={y(k.low)}
                stroke={up ? "var(--bull)" : "var(--bear)"}
                strokeWidth={0.8}
                opacity={0.7}
              />
              {/* Body */}
              <rect
                x={x - bw / 2}
                y={bodyTop}
                width={bw}
                height={bodyH}
                fill={up ? "var(--bull)" : "var(--bear)"}
                opacity={up ? 0.75 : 0.85}
                stroke={isHovered ? "var(--primary)" : "none"}
                strokeWidth={0.8}
                rx={1}
              />
            </g>
          );
        })}

        {/* Volume bars at bottom */}
        {data.map((k, i) => {
          const x = padding.left + i * cw;
          const up = k.close >= k.open;
          const barH = (k.volume / maxVol) * volH * 0.85;
          const yBase = height - 4;
          return (
            <rect
              key={`vol-${i}`}
              x={x + 1}
              y={yBase - barH}
              width={Math.max(cw - 1, 1)}
              height={barH}
              fill={up ? "var(--bull)" : "var(--bear)"}
              opacity={0.35}
            />
          );
        })}

        {/* Mid line */}
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
                strokeDasharray="4 2"
                opacity={0.6}
              />
              <rect
                x={width - 60}
                y={yy - 7}
                width={58}
                height={13}
                fill="var(--primary)"
                rx={3}
                opacity={0.9}
              />
              <text
                x={width - 31}
                y={yy + 2.5}
                fill="var(--primary-foreground)"
                fontSize="9.5"
                textAnchor="middle"
                fontFamily="JetBrains Mono"
                fontWeight="bold"
              >
                {mid > 100 ? mid.toFixed(1) : mid.toFixed(4)}
              </text>
            </g>
          );
        })()}

        {/* Hover crosshair + tooltip */}
        {hover && (
          <g>
            <line
              x1={hover.x}
              x2={hover.x}
              y1={padding.top}
              y2={height - volH}
              stroke="var(--primary)"
              strokeWidth={0.5}
              strokeDasharray="2 2"
              opacity={0.5}
            />
            {hover.candle && (
              <>
                <line
                  x1={padding.left}
                  x2={padding.left + innerW}
                  y1={y(hover.price)}
                  y2={y(hover.price)}
                  stroke="var(--primary)"
                  strokeWidth={0.5}
                  strokeDasharray="2 2"
                  opacity={0.35}
                />
                <rect
                  x={hover.x + 8 > width - 140 ? hover.x - 148 : hover.x + 8}
                  y={padding.top + 4}
                  width={140}
                  height={70}
                  fill="var(--card)"
                  stroke="var(--border)"
                  rx={6}
                  opacity={0.95}
                />
                <text x={hover.x + 8 > width - 140 ? hover.x - 140 : hover.x + 16} y={padding.top + 20}
                  fill="var(--foreground)" fontSize="9.5" fontFamily="JetBrains Mono">
                  O: {hover.candle.open.toFixed(hover.candle.open > 100 ? 1 : 4)}
                </text>
                <text x={hover.x + 8 > width - 140 ? hover.x - 140 : hover.x + 16} y={padding.top + 34}
                  fill="var(--foreground)" fontSize="9.5" fontFamily="JetBrains Mono">
                  H: {hover.candle.high.toFixed(hover.candle.high > 100 ? 1 : 4)}
                </text>
                <text x={hover.x + 8 > width - 140 ? hover.x - 140 : hover.x + 16} y={padding.top + 48}
                  fill="var(--foreground)" fontSize="9.5" fontFamily="JetBrains Mono">
                  L: {hover.candle.low.toFixed(hover.candle.low > 100 ? 1 : 4)}
                </text>
                <text x={hover.x + 8 > width - 140 ? hover.x - 140 : hover.x + 16} y={padding.top + 62}
                  fill={hover.candle.close >= hover.candle.open ? "var(--bull)" : "var(--bear)"}
                  fontSize="9.5" fontFamily="JetBrains Mono" fontWeight="bold">
                  C: {hover.candle.close.toFixed(hover.candle.close > 100 ? 1 : 4)}
                </text>
              </>
            )}
          </g>
        )}
      </svg>
    </div>
  );
}
