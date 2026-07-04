/**
 * CVD Panel — Cumulative Volume Delta (Improved)
 * Shows real buying vs selling pressure behind the price move.
 * Source: price-driven synthetic CVD.
 */
import { useMemo } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell,
} from "recharts";
import type { CVDStats } from "@/hooks/useCVD";
import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus, AlertTriangle, Activity, CheckCircle2 } from "lucide-react";
import { fmtUsd } from "@/lib/binance";

interface Props {
  cvdStats: CVDStats;
  mid: number;
}

function fmtCVD(v: number): string {
  const abs = Math.abs(v);
  const sign = v >= 0 ? "+" : "-";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

export function CVDPanel({ cvdStats, mid }: Props) {
  const { cvd, delta, trend, divergence, divergenceType, points, imbalanceNow } = cvdStats;

  const chartData = useMemo(() =>
    points.map((p, i) => ({
      i,
      cvd: p.cvd,
      delta: p.delta,
      price: p.price,
      t: new Date(p.t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    })),
    [points]
  );

  const deltaData = useMemo(() =>
    points.slice(-20).map((p, i) => ({ i, delta: p.delta })),
    [points]
  );

  const last20 = points.slice(-20);
  const totalBuy  = last20.reduce((s, p) => s + Math.max(0, p.delta), 0);
  const totalSell = last20.reduce((s, p) => s + Math.abs(Math.min(0, p.delta)), 0);
  const totalFlow = totalBuy + totalSell || 1;
  const buyPct    = (totalBuy  / totalFlow) * 100;
  const sellPct   = (totalSell / totalFlow) * 100;

  const isPositive = cvd >= 0;
  const trendColor = trend === "bullish" ? "text-bull" : trend === "bearish" ? "text-bear" : "text-muted-foreground";
  const TrendIcon  = trend === "bullish" ? TrendingUp : trend === "bearish" ? TrendingDown : Minus;

  const imbalancePct = imbalanceNow * 100;

  if (points.length < 3) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-2 text-center text-muted-foreground">
        <Activity className="size-6 animate-pulse" />
        <div className="text-sm">جاري جمع بيانات CVD...</div>
        <div className="text-[10px]">يحتاج إلى تحركات سعرية لتجميع البيانات</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* CVD value */}
        <div className={cn(
          "rounded-xl border p-3",
          isPositive ? "bg-bull/5 border-bull/25" : "bg-bear/5 border-bear/25"
        )}>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">CVD المتراكم</div>
          <div className={cn("mono font-black text-xl mt-1", isPositive ? "text-bull" : "text-bear")}>
            {fmtCVD(cvd)}
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">دولار صافي</div>
        </div>

        {/* Tick delta */}
        <div className={cn(
          "rounded-xl border p-3",
          delta >= 0 ? "bg-bull/5 border-bull/20" : "bg-bear/5 border-bear/20"
        )}>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">آخر دلتا</div>
          <div className={cn("mono font-black text-xl mt-1", delta >= 0 ? "text-bull" : "text-bear")}>
            {fmtCVD(delta)}
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">هذا التيكر</div>
        </div>

        {/* Trend */}
        <div className="rounded-xl border border-border bg-card/40 p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">اتجاه CVD</div>
          <div className={cn("flex items-center gap-1.5 mt-1.5", trendColor)}>
            <TrendIcon className="size-4" />
            <span className="font-bold text-sm">
              {trend === "bullish" ? "صاعد" : trend === "bearish" ? "هابط" : "محايد"}
            </span>
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">
            اختلال الدفتر: <span className={cn("font-semibold", imbalancePct > 5 ? "text-bull" : imbalancePct < -5 ? "text-bear" : "")}>{imbalancePct >= 0 ? "+" : ""}{imbalancePct.toFixed(1)}%</span>
          </div>
        </div>

        {/* Divergence */}
        <div className={cn(
          "rounded-xl border p-3",
          divergence ? "bg-gold/5 border-gold/30" : "bg-card/40 border-border"
        )}>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">تباين CVD/سعر</div>
          {divergence ? (
            <>
              <div className="flex items-center gap-1.5 mt-1.5 text-gold">
                <AlertTriangle className="size-4" />
                <span className="font-bold text-sm">
                  {divergenceType === "hidden_selling" ? "بيع خفي" : "شراء خفي"}
                </span>
              </div>
              <div className="text-[10px] text-gold/80 mt-0.5">
                {divergenceType === "hidden_selling"
                  ? "سعر يصعد لكن المؤسسات تبيع"
                  : "سعر يهبط لكن المؤسسات تتراكم"}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1.5 mt-1.5 text-bull">
                <CheckCircle2 className="size-4" />
                <span className="font-bold text-sm">متوافق</span>
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5">CVD يؤكد الحركة السعرية</div>
            </>
          )}
        </div>
      </div>

      {/* Buy/sell pressure bar */}
      <div className="rounded-xl border border-border bg-secondary/20 p-3 space-y-2">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>ضغط الشراء vs البيع (آخر 20 تيكر)</span>
          <span className="mono">{fmtUsd(totalBuy + totalSell)} إجمالي</span>
        </div>
        <div className="flex rounded-full overflow-hidden h-3 bg-secondary">
          <div className="bg-bull transition-all duration-500" style={{ width: `${buyPct}%` }} />
          <div className="bg-bear transition-all duration-500" style={{ width: `${sellPct}%` }} />
        </div>
        <div className="flex justify-between text-[10px] mono">
          <span className="text-bull">شراء {buyPct.toFixed(0)}% · {fmtUsd(totalBuy)}</span>
          <span className="text-bear">{fmtUsd(totalSell)} · {sellPct.toFixed(0)}% بيع</span>
        </div>
      </div>

      {/* CVD area chart */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">منحنى CVD التراكمي</div>
        <ResponsiveContainer width="100%" height={120}>
          <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="cvdPos" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#22c55e" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#22c55e" stopOpacity={0.0} />
              </linearGradient>
              <linearGradient id="cvdNeg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#ef4444" stopOpacity={0.0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.04)" vertical={false} />
            <XAxis dataKey="t" hide />
            <YAxis
              tickFormatter={v => fmtCVD(v)}
              tick={{ fontSize: 9, fill: "rgba(255,255,255,0.4)" }}
              width={52}
            />
            <Tooltip
              contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 11 }}
              formatter={(v: number) => [fmtCVD(v), "CVD"]}
              labelFormatter={(l: string) => l}
            />
            <ReferenceLine y={0} stroke="rgba(255,255,255,.15)" strokeDasharray="4 2" />
            <Area
              type="monotone"
              dataKey="cvd"
              stroke={isPositive ? "#22c55e" : "#ef4444"}
              strokeWidth={1.5}
              fill={isPositive ? "url(#cvdPos)" : "url(#cvdNeg)"}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Delta bar chart */}
      {deltaData.length >= 5 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            دلتا كل تيكر (آخر 20)
          </div>
          <ResponsiveContainer width="100%" height={60}>
            <BarChart data={deltaData} barSize={8} margin={{ top: 2, right: 2, left: 0, bottom: 0 }}>
              <ReferenceLine y={0} stroke="rgba(255,255,255,.15)" />
              <Bar dataKey="delta" isAnimationActive={false} radius={[2, 2, 0, 0]}>
                {deltaData.map((d, i) => (
                  <Cell
                    key={i}
                    fill={d.delta >= 0 ? "#22c55e" : "#ef4444"}
                    opacity={0.75}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Interpretation */}
      <div className="rounded-lg border border-border/50 bg-secondary/10 px-3 py-2 text-[10px] text-muted-foreground flex items-start gap-2">
        <Activity className="size-3 mt-0.5 flex-shrink-0" />
        <span>
          <span className="text-bull font-semibold">CVD صاعد + سعر صاعد</span> = تأكيد شرائي قوي ·{" "}
          <span className="text-gold font-semibold">CVD هابط + سعر صاعد</span> = بيع خفي (تحذير) ·{" "}
          <span className="text-primary font-semibold">CVD صاعد + سعر هابط</span> = تراكم مؤسساتي (فرصة)
        </span>
      </div>
    </div>
  );
}
