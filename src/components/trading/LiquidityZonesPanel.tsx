import { fmtPct, fmtPrice } from "@/lib/binance";
import type { LiquidityZone } from "@/lib/analysis";
import { cn } from "@/lib/utils";
import { Target, AlertTriangle } from "lucide-react";

export function LiquidityZonesPanel({
  zones,
  mid,
}: {
  zones: LiquidityZone[];
  mid: number;
}) {
  const above = zones.filter((z) => z.side === "above").slice(0, 5);
  const below = zones.filter((z) => z.side === "below").slice(0, 5);

  const topHunt = zones[0];

  return (
    <div className="space-y-4">
      {topHunt && (
        <div
          className={cn(
            "rounded-xl border p-4 glass relative overflow-hidden",
            topHunt.side === "above"
              ? "border-bear/40"
              : "border-bull/40"
          )}
        >
          <div className="absolute -top-12 -left-12 size-32 rounded-full blur-2xl opacity-30"
            style={{
              background: topHunt.side === "above" ? "var(--bear)" : "var(--bull)",
            }}
          />
          <div className="relative flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                <AlertTriangle className="size-3.5 text-gold" />
                أعلى احتمال صيد ستوبات
              </div>
              <div className="mt-1 text-lg font-bold text-foreground">
                {topHunt.side === "above"
                  ? "صيد سيولة فوق القمم (ستوبات البائعين)"
                  : "صيد سيولة تحت القيعان (ستوبات المشترين)"}
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                مستوى مستهدف{" "}
                <span
                  className={cn(
                    "mono font-bold",
                    topHunt.side === "above" ? "text-bear" : "text-bull"
                  )}
                >
                  {fmtPrice(topHunt.price)}
                </span>{" "}
                — مسافة {fmtPct(topHunt.distancePct)} — {topHunt.touches} لمسات
              </div>
            </div>
            <div className="text-left">
              <div className="text-[10px] uppercase text-muted-foreground">
                احتمالية
              </div>
              <div className="text-3xl font-bold mono text-gold">
                {Math.round(topHunt.probability)}%
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <ZoneList
          title="سيولة فوق السعر (ستوبات البائعين)"
          zones={above}
          side="above"
          mid={mid}
        />
        <ZoneList
          title="سيولة تحت السعر (ستوبات المشترين)"
          zones={below}
          side="below"
          mid={mid}
        />
      </div>
    </div>
  );
}

function ZoneList({
  title,
  zones,
  side,
  mid,
}: {
  title: string;
  zones: LiquidityZone[];
  side: "above" | "below";
  mid: number;
}) {
  const isAbove = side === "above";
  return (
    <div className="rounded-xl border border-border bg-card/40 p-3">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
        <Target className={cn("size-3.5", isAbove ? "text-bear" : "text-bull")} />
        {title}
      </div>
      {zones.length === 0 ? (
        <div className="text-xs text-muted-foreground text-center py-6">
          لا توجد تجمعات واضحة
        </div>
      ) : (
        <div className="space-y-1.5">
          {zones.map((z, i) => (
            <div
              key={`${side}-${i}`}
              className="rounded-md border border-border/60 p-2 grid grid-cols-[auto_1fr_auto] items-center gap-3 mono text-[12px]"
            >
              <div
                className={cn(
                  "size-8 rounded-md flex items-center justify-center text-[10px] font-bold",
                  isAbove ? "bg-bear/15 text-bear" : "bg-bull/15 text-bull"
                )}
              >
                {z.touches}x
              </div>
              <div>
                <div
                  className={cn(
                    "font-bold",
                    isAbove ? "text-bear" : "text-bull"
                  )}
                >
                  {fmtPrice(z.price)}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {fmtPct(z.distancePct)} عن السعر
                </div>
              </div>
              <div className="text-left">
                <div className="text-foreground font-bold">
                  {Math.round(z.probability)}%
                </div>
                <div className="text-[10px] text-muted-foreground">احتمال</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
