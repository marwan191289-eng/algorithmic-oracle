import { fmtPct, fmtPrice } from "@/lib/binance";
import type { LiquidityZone } from "@/lib/analysis";
import { cn } from "@/lib/utils";
import { Target, AlertTriangle, Zap, TrendingUp, TrendingDown, Activity, BookOpen } from "lucide-react";

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
  const above   = zones.filter((z) => z.side === "above").slice(0, 5);
  const below   = zones.filter((z) => z.side === "below").slice(0, 5);
  const topHunt = zones[0];

  // Critical zones: probability ≥ 72
  const critical = zones.filter(z => z.probability >= 72);

  return (
    <div className="space-y-4">
      {/* Top zone hero card */}
      {topHunt && (
        <div className={cn(
          "rounded-xl border p-4 glass relative overflow-hidden",
          topHunt.side === "above" ? "border-bear/40" : "border-bull/40"
        )}>
          <div
            className="absolute -top-12 -left-12 size-32 rounded-full blur-2xl opacity-30"
            style={{ background: topHunt.side === "above" ? "var(--bear)" : "var(--bull)" }}
          />
          <div className="relative flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground flex-wrap">
                <AlertTriangle className="size-3.5 text-gold flex-shrink-0" />
                أعلى احتمال صيد ستوبات
                {topHunt.zoneType && (
                  <span className={cn("px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase tracking-wider", ZONE_TYPE_COLOR[topHunt.zoneType])}>
                    {ZONE_TYPE_LABEL[topHunt.zoneType]}
                  </span>
                )}
              </div>
              <div className="mt-1 text-base font-bold text-foreground">
                {topHunt.side === "above"
                  ? "سيولة فوق القمم — ستوبات البائعين"
                  : "سيولة تحت القيعان — ستوبات المشترين"}
              </div>
              <div className="mt-1 text-[12px] text-muted-foreground">
                مستوى{" "}
                <span className={cn("mono font-bold", topHunt.side === "above" ? "text-bear" : "text-bull")}>
                  {fmtPrice(topHunt.price)}
                </span>
                {topHunt.zoneHigh !== topHunt.zoneLow && (
                  <span className="text-muted-foreground/60">
                    {" "}({fmtPrice(topHunt.zoneLow)} – {fmtPrice(topHunt.zoneHigh)})
                  </span>
                )}
                {" · "}{fmtPct(topHunt.distancePct)} · {topHunt.touches} لمسات
              </div>
              {/* Badges */}
              <div className="flex flex-wrap gap-1.5 mt-2">
                {topHunt.equalLevel && (
                  <Badge color="gold" label="قمم/قيعان متساوية" />
                )}
                {topHunt.induced && (
                  <Badge color="primary" label="⚡ اختراق مُزيف" />
                )}
                {topHunt.volumeScore >= 0.65 && (
                  <Badge color="bull" label={`حجم قوي ${(topHunt.volumeScore * 100).toFixed(0)}%`} />
                )}
                {topHunt.wallConfluence && (
                  <Badge color="whale" label="جدار كتاب" />
                )}
              </div>
            </div>
            <div className="text-left flex-shrink-0">
              <div className="text-[10px] uppercase text-muted-foreground">احتمالية</div>
              <div className={cn(
                "text-3xl font-bold mono",
                topHunt.probability >= 75 ? "text-gold" : "text-muted-foreground"
              )}>
                {Math.round(topHunt.probability)}%
              </div>
              {/* Volume bar */}
              <div className="mt-1.5 w-16">
                <div className="text-[9px] text-muted-foreground mb-0.5">حجم</div>
                <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gold/70"
                    style={{ width: `${(topHunt.volumeScore * 100).toFixed(0)}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Critical zones alert */}
      {critical.length > 1 && (
        <div className="rounded-xl border border-gold/30 bg-gold/5 px-3 py-2 flex items-center gap-2 text-[11px] text-gold">
          <Activity className="size-3.5 flex-shrink-0" />
          <span>{critical.length} مناطق بنسبة ≥ 72% — خطر صيد مرتفع</span>
        </div>
      )}

      {/* Zone lists */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <ZoneList title="سيولة فوق السعر (ستوبات البائعين)" zones={above} side="above" mid={mid} />
        <ZoneList title="سيولة تحت السعر (ستوبات المشترين)" zones={below} side="below" mid={mid} />
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground px-1">
        <LegendItem color="text-gold"    label="قمم/قيعان متساوية" />
        <LegendItem color="text-primary" label="⚡ اختراق مزيف (inducement)" />
        <LegendItem color="text-bull"    label="حجم مرتفع عند اللمس" />
        <LegendItem color="text-whale"    label="جدار كتاب داخل المنطقة" />
      </div>
    </div>
  );
}

function ZoneList({ title, zones, side, mid }: {
  title: string; zones: LiquidityZone[]; side: "above" | "below"; mid: number;
}) {
  const isAbove = side === "above";
  return (
    <div className="rounded-xl border border-border bg-card/40 p-3">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground mb-3">
        {isAbove
          ? <TrendingUp   className="size-3.5 text-bear" />
          : <TrendingDown className="size-3.5 text-bull" />
        }
        {title}
      </div>

      {zones.length === 0 ? (
        <div className="text-xs text-muted-foreground text-center py-6">لا توجد تجمعات واضحة</div>
      ) : (
        <div className="space-y-2">
          {zones.map((z, i) => (
            <ZoneRow key={`${side}-${i}`} zone={z} isAbove={isAbove} mid={mid} />
          ))}
        </div>
      )}
    </div>
  );
}

function ZoneRow({ zone: z, isAbove, mid }: { zone: LiquidityZone; isAbove: boolean; mid: number }) {
  const probColor = z.probability >= 75 ? "text-gold" : z.probability >= 55 ? "text-muted-foreground" : "text-muted-foreground/60";
  const probBg    = z.probability >= 75 ? "bg-gold/10 border-gold/30" : "bg-card/40 border-border/50";

  return (
    <div className={cn(
      "rounded-lg border p-2.5 space-y-2",
      z.probability >= 75 ? "border-gold/20 bg-gold/3" : "border-border/60 bg-card/20"
    )}>
      {/* Row 1: touches badge + price + zone info + probability */}
      <div className="flex items-center gap-2.5">
        <div className={cn(
          "size-8 rounded-md flex items-center justify-center text-[10px] font-bold flex-shrink-0",
          isAbove ? "bg-bear/15 text-bear" : "bg-bull/15 text-bull"
        )}>
          {z.touches}x
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={cn("mono font-bold text-[13px]", isAbove ? "text-bear" : "text-bull")}>
              {fmtPrice(z.price)}
            </span>
            {z.zoneType && (
              <span className={cn("px-1 py-0.5 rounded border text-[8px] font-bold", ZONE_TYPE_COLOR[z.zoneType])}>
                {ZONE_TYPE_LABEL[z.zoneType]}
              </span>
            )}
            {z.equalLevel && <Target className="size-3 text-gold" />}
            {z.induced    && <Zap    className="size-3 text-primary" />}
            {z.wallConfluence && <BookOpen className="size-3 text-whale" />}
          </div>
          {z.zoneHigh !== z.zoneLow && (
            <div className="text-[9px] text-muted-foreground mono">
              نطاق: {fmtPrice(z.zoneLow)} – {fmtPrice(z.zoneHigh)}
            </div>
          )}
        </div>

        <div className={cn("rounded-md px-2 py-1 text-left border", probBg)}>
          <div className={cn("mono font-bold text-[13px]", probColor)}>
            {Math.round(z.probability)}%
          </div>
          <div className="text-[9px] text-muted-foreground">احتمال</div>
        </div>
      </div>

      {/* Row 2: distance + volume bar */}
      <div className="flex items-center gap-3">
        <span className="text-[10px] text-muted-foreground mono">{fmtPct(z.distancePct)}</span>
        <div className="flex-1 h-1.5 rounded-full bg-secondary overflow-hidden">
          <div
            className="h-full rounded-full bg-gold/50 transition-all duration-500"
            style={{ width: `${(z.volumeScore * 100).toFixed(0)}%` }}
          />
        </div>
        <span className="text-[9px] text-muted-foreground">{(z.volumeScore * 100).toFixed(0)}% حجم</span>
      </div>

      {/* Probability bar */}
      <div className="h-1 rounded-full bg-secondary overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            z.probability >= 75 ? "bg-gold" : isAbove ? "bg-bear/50" : "bg-bull/50"
          )}
          style={{ width: `${z.probability}%` }}
        />
      </div>
    </div>
  );
}

type BadgeColor = "gold" | "bull" | "bear" | "primary" | "whale";

function Badge({ color, label }: { color: BadgeColor; label: string }) {
  const cls: Record<BadgeColor, string> = {
    gold:    "bg-gold/10    text-gold    border-gold/30",
    bull:    "bg-bull/10    text-bull    border-bull/30",
    bear:    "bg-bear/10    text-bear    border-bear/30",
    primary: "bg-primary/10 text-primary border-primary/30",
    whale:   "bg-whale/10   text-whale   border-whale/30",
  };
  return (
    <span className={cn("text-[9px] px-1.5 py-0.5 rounded-full border font-medium inline-flex items-center gap-1", cls[color])}>
      {label}
    </span>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className={cn("flex items-center gap-1", color)}>
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
