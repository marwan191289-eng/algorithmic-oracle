/**
 * OFI Heatmap — Order Flow Imbalance per price level
 *
 * Visualises WHERE institutional orders are being placed or cancelled
 * in real-time, using order-book delta between 1-second snapshots.
 *
 * Green bars  = buyers adding new bids at that level (institutional buy flow)
 * Red bars    = sellers adding new asks at that level (institutional sell flow)
 * Bar width   = magnitude relative to largest flow this tick
 */
import { useMemo } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import type { OFIStats } from "@/hooks/useOFI";
import { cn } from "@/lib/utils";
import { fmtPrice, fmtUsd } from "@/lib/binance";
import { TrendingUp, TrendingDown, Minus, Activity } from "lucide-react";

interface Props {
  ofi: OFIStats;
  mid: number;
}

function fmtOFI(v: number): string {
  const abs  = Math.abs(v);
  const sign = v >= 0 ? "+" : "−";
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

export function OFIHeatmap({ ofi, mid }: Props) {
  const { current, history, rollingNet, pressure } = ofi;

  // Rolling net OFI chart data
  const chartData = useMemo(() =>
    history.map((s, i) => ({
      i,
      net:  s.netOFI,
      buy:  s.bidOFI,
      sell: -s.askOFI,
    })),
    [history]
  );

  const pressureColor =
    pressure === "buy"  ? "text-bull"
    : pressure === "sell" ? "text-bear"
    : "text-muted-foreground";

  const PressureIcon =
    pressure === "buy"  ? TrendingUp
    : pressure === "sell" ? TrendingDown
    : Minus;

  if (!current || current.levels.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-3 text-muted-foreground">
        <Activity className="size-6 animate-pulse text-primary" />
        <div className="text-sm text-center">
          <div>جاري رصد تدفقات الأوامر...</div>
          <div className="text-[10px] mt-0.5 opacity-70">يحتاج إلى تحديثين متتاليين للأوردر بوك</div>
        </div>
      </div>
    );
  }

  const { levels, bidOFI, askOFI, maxAbsOFI } = current;

  // Split levels into asks (above mid) and bids (below mid)
  const askLevels = levels.filter(l => l.side === "ask").sort((a, b) => b.price - a.price).slice(0, 10);
  const bidLevels = levels.filter(l => l.side === "bid").sort((a, b) => b.price - a.price).slice(0, 10);

  return (
    <div className="space-y-4">
      {/* KPI strip */}
      <div className="grid grid-cols-3 gap-3">
        {/* Net OFI */}
        <div className={cn(
          "rounded-xl border p-3",
          rollingNet > 0 ? "bg-bull/5 border-bull/25" : rollingNet < 0 ? "bg-bear/5 border-bear/25" : "bg-card/40 border-border"
        )}>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">OFI الصافي (10 تيكر)</div>
          <div className={cn("mono font-black text-xl mt-1", rollingNet > 0 ? "text-bull" : rollingNet < 0 ? "text-bear" : "text-muted-foreground")}>
            {fmtOFI(rollingNet)}
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">دولار</div>
        </div>

        {/* Buy / Sell this tick */}
        <div className="rounded-xl border border-border bg-card/40 p-3 space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">هذا التيكر</div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-bull mono">+{fmtUsd(bidOFI)}</span>
            <span className="text-[10px] text-muted-foreground">شراء</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-bear mono">−{fmtUsd(askOFI)}</span>
            <span className="text-[10px] text-muted-foreground">بيع</span>
          </div>
        </div>

        {/* Pressure */}
        <div className="rounded-xl border border-border bg-card/40 p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">ضغط الأوامر</div>
          <div className={cn("flex items-center gap-1.5 mt-1.5", pressureColor)}>
            <PressureIcon className="size-4" />
            <span className="font-bold text-sm">
              {pressure === "buy" ? "شرائي" : pressure === "sell" ? "بيعي" : "محايد"}
            </span>
          </div>
          <div className="text-[9px] text-muted-foreground mt-0.5">متراكم 10 تيكرات</div>
        </div>
      </div>

      {/* Heatmap grid */}
      <div className="rounded-xl border border-border overflow-hidden">
        {/* Header */}
        <div className="grid grid-cols-[80px_1fr_80px] bg-secondary/30 px-3 py-1.5 text-[9px] uppercase tracking-wider text-muted-foreground border-b border-border">
          <span>OFI</span>
          <span className="text-center">السعر</span>
          <span className="text-left">حجم قائم</span>
        </div>

        {/* Asks (above mid) — sold-side flow */}
        {askLevels.length > 0 && (
          <div className="border-b border-border/40">
            {askLevels.map((l, i) => (
              <OFIRow key={`ask-${l.price}-${i}`} level={l} maxOFI={maxAbsOFI} mid={mid} />
            ))}
          </div>
        )}

        {/* Mid price separator */}
        <div className="grid grid-cols-[80px_1fr_80px] px-3 py-1 bg-primary/5 border-y border-primary/20">
          <span />
          <div className="text-center mono text-[11px] font-bold text-primary">{fmtPrice(mid)}</div>
          <span className="text-[9px] text-muted-foreground text-left">mid</span>
        </div>

        {/* Bids (below mid) — buy-side flow */}
        {bidLevels.length > 0 && (
          <div>
            {bidLevels.map((l, i) => (
              <OFIRow key={`bid-${l.price}-${i}`} level={l} maxOFI={maxAbsOFI} mid={mid} />
            ))}
          </div>
        )}
      </div>

      {/* Rolling OFI chart */}
      {chartData.length >= 5 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            تاريخ OFI الصافي (آخر {chartData.length} تيكر)
          </div>
          <ResponsiveContainer width="100%" height={80}>
            <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="ofiPos" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="var(--color-bull,#22c55e)" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="var(--color-bull,#22c55e)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="ofiNeg" x1="0" y1="1" x2="0" y2="0">
                  <stop offset="5%"  stopColor="var(--color-bear,#ef4444)" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="var(--color-bear,#ef4444)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.04)" vertical={false} />
              <XAxis dataKey="i" hide />
              <YAxis tickFormatter={v => fmtOFI(v)} tick={{ fontSize: 9, fill: "var(--muted-foreground,#888)" }} width={50} />
              <Tooltip
                contentStyle={{ background:"var(--card,#1a1a2e)", border:"1px solid var(--border)", borderRadius:8, fontSize:11 }}
                formatter={(v: number, name: string) => [fmtOFI(v), name === "net" ? "OFI صافي" : name]}
              />
              <ReferenceLine y={0} stroke="rgba(255,255,255,.15)" strokeDasharray="4 2" />
              <Area type="monotone" dataKey="net"
                stroke={rollingNet >= 0 ? "var(--color-bull,#22c55e)" : "var(--color-bear,#ef4444)"}
                strokeWidth={1.5}
                fill={rollingNet >= 0 ? "url(#ofiPos)" : "url(#ofiNeg)"}
                dot={false} isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-4 text-[10px] text-muted-foreground px-1">
        <span className="flex items-center gap-1.5 text-bull">
          <span className="size-2 rounded-sm bg-bull/70" /> أوامر شراء مضافة
        </span>
        <span className="flex items-center gap-1.5 text-bear">
          <span className="size-2 rounded-sm bg-bear/70" /> أوامر بيع مضافة
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-muted-foreground/30" /> ملغاة / ممتصة
        </span>
      </div>
    </div>
  );
}

// ── Single OFI row ────────────────────────────────────────────────────────
function OFIRow({ level, maxOFI, mid }: { level: import("@/hooks/useOFI").OFILevel; maxOFI: number; mid: number }) {
  const { price, side, ofi, cumUsd } = level;
  const isAbove  = price > mid;
  const isBid    = side === "bid";
  const pctWidth = Math.min(100, (Math.abs(ofi) / maxOFI) * 100);
  const isPositive = ofi > 0;

  // Color: bid flow positive = green, ask flow (stored as negative) means we show red
  const barColor  = isBid
    ? (isPositive ? "bg-bull" : "bg-bull/20")     // bid reinforced vs reduced
    : (isPositive ? "bg-bear/20" : "bg-bear");    // ask reduced vs reinforced

  const textColor = isBid
    ? (isPositive ? "text-bull" : "text-muted-foreground")
    : (isPositive ? "text-muted-foreground" : "text-bear");

  const distPct = ((price - mid) / mid * 100);

  return (
    <div className={cn(
      "grid grid-cols-[80px_1fr_80px] items-center px-3 py-[3px] border-b border-border/20 last:border-0",
      "hover:bg-secondary/20 transition-colors",
      Math.abs(ofi) > maxOFI * 0.6 && "bg-primary/3"
    )}>
      {/* OFI bar + value */}
      <div className="flex items-center gap-1">
        <div className="w-10 h-3 rounded-sm bg-secondary overflow-hidden flex-shrink-0">
          <div
            className={cn("h-full rounded-sm transition-all duration-300", barColor)}
            style={{ width: `${pctWidth}%` }}
          />
        </div>
        <span className={cn("text-[9px] mono", textColor)}>
          {fmtOFI(ofi)}
        </span>
      </div>

      {/* Price */}
      <div className="text-center mono text-[11px] font-semibold flex items-center justify-center gap-1">
        <span className={isAbove ? "text-bear" : "text-bull"}>
          {fmtPrice(price)}
        </span>
        <span className="text-[9px] text-muted-foreground/60">
          {distPct > 0 ? "+" : ""}{distPct.toFixed(2)}%
        </span>
      </div>

      {/* Standing USD */}
      <div className="text-left mono text-[9px] text-muted-foreground">
        {fmtUsd(cumUsd)}
      </div>
    </div>
  );
}
