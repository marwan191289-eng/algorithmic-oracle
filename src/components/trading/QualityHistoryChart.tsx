import { useSession } from "@/lib/session-store";
import { cn } from "@/lib/utils";
import { TrendingDown, TrendingUp, Minus } from "lucide-react";
import { useMemo } from "react";

/** Linear regression slope on score (per minute) */
function slopePerMin(samples: { t: number; score: number }[]): number {
  if (samples.length < 5) return 0;
  const n = samples.length;
  const t0 = samples[0].t;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const s of samples) {
    const x = (s.t - t0) / 60000; // minutes
    const y = s.score;
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (n * sxy - sx * sy) / denom;
}

const EMPTY_HISTORY: import("@/lib/session-store").QualitySample[] = [];

export function QualityHistoryChart({ symbol }: { symbol: string }) {
  const history = useSession((s) => s.qualityHistory[symbol] ?? EMPTY_HISTORY);

  const { slope, avg, recentAvg, drop, trend } = useMemo(() => {
    if (history.length < 10)
      return { slope: 0, avg: 0, recentAvg: 0, drop: 0, trend: "flat" as const };
    const last10min = history.filter((s) => Date.now() - s.t < 10 * 60_000);
    const last2min = history.filter((s) => Date.now() - s.t < 2 * 60_000);
    const avg = last10min.reduce((a, s) => a + s.score, 0) / Math.max(1, last10min.length);
    const recentAvg = last2min.reduce((a, s) => a + s.score, 0) / Math.max(1, last2min.length);
    const slope = slopePerMin(last10min);
    const drop = avg - recentAvg;
    const trend: "up" | "down" | "flat" =
      slope > 1.2 ? "up" : slope < -1.2 ? "down" : "flat";
    return { slope, avg, recentAvg, drop, trend };
  }, [history]);

  // Build sparkline path
  const path = useMemo(() => {
    if (history.length < 2) return "";
    const W = 600, H = 60;
    const xs = history.map((s) => s.t);
    const tMin = xs[0], tMax = xs[xs.length - 1];
    const span = Math.max(1, tMax - tMin);
    const pts = history.map((s) => {
      const x = ((s.t - tMin) / span) * W;
      const y = H - (Math.max(0, Math.min(100, s.score)) / 100) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return "M" + pts.join(" L");
  }, [history]);

  const latPath = useMemo(() => {
    if (history.length < 2) return "";
    const W = 600, H = 30;
    const xs = history.map((s) => s.t);
    const tMin = xs[0], tMax = xs[xs.length - 1];
    const span = Math.max(1, tMax - tMin);
    const cap = 1000;
    const pts = history.map((s) => {
      const x = ((s.t - tMin) / span) * W;
      const y = H - (Math.min(cap, s.latencyMs) / cap) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return "M" + pts.join(" L");
  }, [history]);

  const disconnects = history.filter((s) => !s.connected).length;
  const minutesCovered = history.length / 60;

  const trendTone =
    trend === "down" ? "text-bear border-bear/40 bg-bear/10"
    : trend === "up" ? "text-bull border-bull/40 bg-bull/10"
    : "text-muted-foreground border-border";

  return (
    <div className="rounded-2xl border border-border bg-card/40 p-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm font-semibold">تاريخ جودة البيانات — آخر ساعة</div>
        <div className="flex items-center gap-2 text-[11px] mono">
          <span className={cn("px-2 py-0.5 rounded border", trendTone)}>
            {trend === "down" ? <TrendingDown className="inline size-3 mr-1" />
             : trend === "up" ? <TrendingUp className="inline size-3 mr-1" />
             : <Minus className="inline size-3 mr-1" />}
            ميل {slope >= 0 ? "+" : ""}{slope.toFixed(2)} /د
          </span>
          <span className="text-muted-foreground">عينات: {history.length} ({minutesCovered.toFixed(1)}د)</span>
        </div>
      </div>

      {history.length < 10 ? (
        <div className="mt-3 text-xs text-muted-foreground text-center py-6">
          جارٍ جمع العينات… ({history.length}/10)
        </div>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-4 gap-2 text-[11px] mono">
            <Stat label="متوسط 10د" value={`${avg.toFixed(0)}/100`} />
            <Stat label="متوسط 2د" value={`${recentAvg.toFixed(0)}/100`}
                  tone={drop > 8 ? "bad" : drop > 3 ? "warn" : "ok"} />
            <Stat label="انخفاض" value={`${drop >= 0 ? "-" : "+"}${Math.abs(drop).toFixed(1)}`}
                  tone={drop > 8 ? "bad" : drop > 3 ? "warn" : "ok"} />
            <Stat label="انقطاعات" value={`${disconnects}`}
                  tone={disconnects > 0 ? "warn" : "ok"} />
          </div>

          <div className="mt-3">
            <div className="text-[10px] text-muted-foreground mb-1">الدقة (0→100)</div>
            <svg viewBox="0 0 600 60" className="w-full h-14" preserveAspectRatio="none">
              <line x1="0" y1="33" x2="600" y2="33" stroke="hsl(var(--border))" strokeDasharray="2 4" />
              <path d={path} fill="none" stroke="hsl(var(--primary))" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </svg>
            <div className="text-[10px] text-muted-foreground mt-2 mb-1">التأخر (ms, cap 1000)</div>
            <svg viewBox="0 0 600 30" className="w-full h-8" preserveAspectRatio="none">
              <path d={latPath} fill="none" stroke="hsl(var(--gold))" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </svg>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone = "neutral" }: {
  label: string; value: string; tone?: "ok" | "warn" | "bad" | "neutral";
}) {
  const cls =
    tone === "ok" ? "text-bull border-bull/30"
    : tone === "warn" ? "text-gold border-gold/30"
    : tone === "bad" ? "text-bear border-bear/30"
    : "text-foreground border-border";
  return (
    <div className={cn("rounded-md border px-2 py-1.5 flex items-center justify-between bg-card/30", cls)}>
      <span className="opacity-70">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

/** Hook: should we block based on TREND, not instantaneous? */
export function useQualityBlockDecision(symbol: string): {
  blocked: boolean;
  reason: string;
} {
  const history = useSession((s) => s.qualityHistory[symbol] ?? EMPTY_HISTORY);
  const enabled = useSession((s) => s.quality.blockOnLowQuality);
  const min = useSession((s) => s.quality.minAcceptableScore);
  const live = useSession((s) => s.quality.bySymbol[symbol]);

  if (!enabled) return { blocked: false, reason: "" };
  if (history.length < 15) {
    // bootstrap: fall back to instantaneous gate
    if ((live?.score ?? 0) < min)
      return { blocked: true, reason: `الدقة اللحظية ${live?.score ?? 0} دون الحد ${min}` };
    return { blocked: false, reason: "" };
  }

  const last2min = history.filter((s) => Date.now() - s.t < 2 * 60_000);
  const last10min = history.filter((s) => Date.now() - s.t < 10 * 60_000);
  const recentAvg = last2min.reduce((a, s) => a + s.score, 0) / Math.max(1, last2min.length);
  const baseAvg = last10min.reduce((a, s) => a + s.score, 0) / Math.max(1, last10min.length);
  const slope = slopePerMin(last10min);
  const drop = baseAvg - recentAvg;

  // Conditions for blocking based on TREND:
  if (recentAvg < min - 5)
    return { blocked: true, reason: `متوسط آخر دقيقتين ${recentAvg.toFixed(0)} أقل من ${min - 5}` };
  if (slope < -2.5 && recentAvg < min + 10)
    return { blocked: true, reason: `اتجاه انخفاض حاد (${slope.toFixed(1)}/د) قرب الحد` };
  if (drop > 15)
    return { blocked: true, reason: `انخفاض ${drop.toFixed(1)} نقطة عن متوسط 10د` };
  const disc = last2min.filter((s) => !s.connected).length;
  if (disc > 10)
    return { blocked: true, reason: `${disc} ثوانٍ منقطعة في آخر دقيقتين` };
  return { blocked: false, reason: "" };
}
