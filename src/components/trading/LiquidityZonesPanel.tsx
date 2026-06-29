import { fmtPct, fmtPrice } from "@/lib/binance";
import type { LiquidityZone } from "@/lib/analysis";
import { cn } from "@/lib/utils";
import { Target, AlertTriangle, Zap, TrendingUp, TrendingDown, BookOpen } from "lucide-react";

const ZONE_TYPE_LABEL: Record<NonNullable<LiquidityZone["zoneType"]>, string> = {
  equal_highs: "قمم متساوية",
  equal_lows:  "قيعان متساوية",
  swing_high:  "قمة تأرجح",
  swing_low:   "قاع تأرجح",
};

const ZONE_TYPE_COLOR: Record<NonNullable<LiquidityZone["zoneType"]>, string> = {
  equal_highs: "text-bear border-bear/40 bg-bear/10",
  equal_lows:  "text-bull border-bull/40 bg-bull/10",
  swing_high:  "text-bear/70 border-bear/25 bg-bear/5",
  swing_low:   "text-bull/70 border-bull/25 bg-bull/5",
};

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
            topHunt.side === "above" ? "border-bear/40" : "border-bull/40"
          )}
        >
          <div
            className="absolute -top-12 -left-12 size-32 rounded-full blur-2xl opacity-30"
            style={{ background: topHunt.side === "above" ? "var(--bear)" : "var(--bull)" }}
          />
          <div className="relative flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground flex-wrap">
                <AlertTriangle className="size-3.5 text-gold" />
                أعلى احتمال صيد ستوبات
                {topHunt.zoneType && (
                  <span className={cn("px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase tracking-wider", ZONE_TYPE_COLOR[topHunt.zoneType])}>
                    {ZONE_TYPE_LABEL[topHunt.zoneType]}
                  </span>
                )}
              </div>
              <div className="mt-1 text-lg font-bold text-foreground">
                {topHunt.side === "above"
                  ? "صيد سيولة فوق القمم (ستوبات البائعين)"
                  : "صيد سيولة تحت القيعان (ستوبات المشترين)"}
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                مستوى مستهدف{" "}
                <span className={cn("mono font-bold", topHunt.side === "above" ? "text-bear" : "text-bull")}>
                  {fmtPrice(topHunt.price)}
                </span>{" "}
                — مسافة {fmtPct(topHunt.distancePct)} — {topHunt.touches} لمسات
              </div>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                {topHunt.equalLevel && (
                  <Badge color="text-gold border-gold/40 bg-gold/10">
                    <Zap className="size-2.5" /> متساوية
                  </Badge>
                )}
                {topHunt.induced && (
                  <Badge color="text-primary border-primary/40 bg-primary/10">
                    <TrendingDown className="size-2.5" /> استدراج مؤكد
                  </Badge>
                )}
                {topHunt.wallConfluence && (
                  <Badge color="text-whale border-whale/40 bg-whale/10">
                    <BookOpen className="size-2.5" /> جدار كتاب
                  </Badge>
                )}
              </div>
            </div>
            <div className="text-left shrink-0">
              <div className="text-[10px] uppercase text-muted-foreground">احتمالية</div>
              <div className="text-3xl font-bold mono text-gold">{Math.round(topHunt.probability)}%</div>
              {topHunt.volumeWeight != null && (
                <div className="text-[10px] mono text-muted-foreground mt-0.5">
                  حجم {Math.round(topHunt.volumeWeight * 100)}%
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <ZoneList title="سيولة فوق السعر (ستوبات البائعين)" zones={above} side="above" mid={mid} />
        <ZoneList title="سيولة تحت السعر (ستوبات المشترين)" zones={below} side="below" mid={mid} />
      </div>
    </div>
  );
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-bold", color)}>
      {children}
    </span>
  );
}

function ZoneList({
  title, zones, side, mid,
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
        <div className="text-xs text-muted-foreground text-center py-6">لا توجد تجمعات واضحة</div>
      ) : (
        <div className="space-y-1.5">
          {zones.map((z, i) => (
            <ZoneRow key={`${side}-${i}`} z={z} isAbove={isAbove} />
          ))}
        </div>
      )}
    </div>
  );
}

function ZoneRow({ z, isAbove }: { z: LiquidityZone; isAbove: boolean }) {
  const volPct = z.volumeWeight != null ? Math.round(z.volumeWeight * 100) : null;

  return (
    <div className="rounded-md border border-border/60 p-2 grid grid-cols-[auto_1fr_auto] items-center gap-2 mono text-[12px]">
      {/* Touches bubble */}
      <div className={cn(
        "size-8 rounded-md flex items-center justify-center text-[10px] font-bold shrink-0",
        isAbove ? "bg-bear/15 text-bear" : "bg-bull/15 text-bull"
      )}>
        {z.touches}x
      </div>

      {/* Price + badges */}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={cn("font-bold", isAbove ? "text-bear" : "text-bull")}>
            {fmtPrice(z.price)}
          </span>
          {z.zoneType && (
            <span className={cn("px-1 py-0.5 rounded border text-[8px] font-bold", ZONE_TYPE_COLOR[z.zoneType])}>
              {ZONE_TYPE_LABEL[z.zoneType]}
            </span>
          )}
          {z.wallConfluence && (
            <BookOpen className="size-2.5 text-whale shrink-0" />
          )}
          {z.induced && (
            <Zap className="size-2.5 text-primary shrink-0" />
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
          <span>{fmtPct(z.distancePct)} عن السعر</span>
          {volPct != null && (
            <>
              <span className="opacity-40">·</span>
              <span className="flex items-center gap-0.5">
                {isAbove
                  ? <TrendingUp className="size-2.5 opacity-60" />
                  : <TrendingDown className="size-2.5 opacity-60" />
                }
                حجم {volPct}%
              </span>
            </>
          )}
        </div>
      </div>

      {/* Probability + volume bar */}
      <div className="text-left shrink-0">
        <div className={cn("font-bold", z.probability >= 70 ? "text-gold" : "text-foreground")}>
          {Math.round(z.probability)}%
        </div>
        {volPct != null && (
          <div className="w-12 h-1 rounded-full bg-secondary mt-1 overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all", isAbove ? "bg-bear/60" : "bg-bull/60")}
              style={{ width: `${volPct}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
