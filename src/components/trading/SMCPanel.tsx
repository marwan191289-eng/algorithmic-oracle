/**
 * SMC Panel — Smart Money Concepts structural display
 *
 * Shows BOS / CHOCH events, active Fair Value Gaps, and Order Blocks
 * extracted from OHLCV candle data in real-time.
 */
import { useMemo } from "react";
import type { SMCAnalysis, StructureEvent, FairValueGap, OrderBlock } from "@/lib/smc";
import { fmtPrice } from "@/lib/binance";
import { cn } from "@/lib/utils";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
  Layers,
  GitMerge,
} from "lucide-react";

interface Props {
  analysis: SMCAnalysis;
  currentPrice: number;
  interval: string;
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)  return `${s}ث`;
  if (s < 3600) return `${Math.floor(s / 60)}د`;
  return `${Math.floor(s / 3600)}س`;
}

function distPct(a: number, b: number) {
  return (((a - b) / b) * 100).toFixed(2);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TrendBadge({ trend }: { trend: SMCAnalysis["trend"] }) {
  if (trend === "up") return (
    <div className="flex items-center gap-1.5 text-bull font-bold">
      <TrendingUp className="size-4" />
      <span>صاعد (HH + HL)</span>
    </div>
  );
  if (trend === "down") return (
    <div className="flex items-center gap-1.5 text-bear font-bold">
      <TrendingDown className="size-4" />
      <span>هابط (LH + LL)</span>
    </div>
  );
  return (
    <div className="flex items-center gap-1.5 text-muted-foreground font-bold">
      <Minus className="size-4" />
      <span>متذبذب</span>
    </div>
  );
}

function EventCard({ ev, label }: { ev: StructureEvent; label: string }) {
  const isBull = ev.direction === "bullish";
  return (
    <div className={cn(
      "rounded-xl border p-3 flex flex-col gap-1",
      isBull ? "bg-bull/5 border-bull/20" : "bg-bear/5 border-bear/20"
    )}>
      <div className="flex items-center justify-between">
        <span className={cn(
          "text-[10px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded",
          ev.kind === "CHOCH"
            ? isBull ? "bg-bull/20 text-bull" : "bg-bear/20 text-bear"
            : isBull ? "bg-bull/10 text-bull/80" : "bg-bear/10 text-bear/80"
        )}>
          {ev.kind}
        </span>
        <span className={cn("text-[10px] font-semibold", isBull ? "text-bull" : "text-bear")}>
          {isBull ? "↑ شرائي" : "↓ بيعي"}
        </span>
      </div>
      <div className="mono text-sm font-black mt-0.5">{fmtPrice(ev.level)}</div>
      <div className="text-[10px] text-muted-foreground">المستوى المكسور · منذ {timeAgo(ev.timestamp)}</div>
      {ev.kind === "CHOCH" && (
        <div className="text-[9px] text-gold mt-0.5">⚠ إشارة انعكاس هيكل السوق</div>
      )}
    </div>
  );
}

function FVGRow({ fvg, price }: { fvg: FairValueGap; price: number }) {
  const isBull = fvg.direction === "bullish";
  const dist   = distPct(fvg.mid, price);
  const inZone = price >= fvg.bottom && price <= fvg.top;

  return (
    <div className={cn(
      "flex items-center gap-2 px-3 py-2 rounded-lg border",
      inZone
        ? isBull ? "bg-bull/10 border-bull/30" : "bg-bear/10 border-bear/30"
        : "bg-card/40 border-border",
      "text-[11px]"
    )}>
      {/* Direction badge */}
      <span className={cn(
        "size-5 rounded flex items-center justify-center text-[9px] font-bold flex-shrink-0",
        isBull ? "bg-bull/20 text-bull" : "bg-bear/20 text-bear"
      )}>
        {isBull ? "↑" : "↓"}
      </span>

      {/* Range */}
      <div className="flex-1 min-w-0">
        <div className="mono font-semibold">
          {fmtPrice(fvg.bottom)} – {fmtPrice(fvg.top)}
        </div>
        <div className="text-[9px] text-muted-foreground">
          {isBull ? "FVG شرائي" : "FVG بيعي"} · {timeAgo(fvg.timestamp)}
          {inZone && <span className="text-gold ml-1">● في المنطقة</span>}
        </div>
      </div>

      {/* Fill progress */}
      <div className="text-left flex-shrink-0">
        <div className="text-[10px] mono font-bold">{dist}%</div>
        <div className="w-10 h-1.5 bg-secondary rounded-full mt-0.5 overflow-hidden">
          <div
            className={cn("h-full rounded-full", isBull ? "bg-bull" : "bg-bear")}
            style={{ width: `${Math.min(100, fvg.fillPct)}%` }}
          />
        </div>
        <div className="text-[8px] text-muted-foreground text-left">{fvg.fillPct}% ممتلئ</div>
      </div>
    </div>
  );
}

function OBRow({ ob, price }: { ob: OrderBlock; price: number }) {
  const isBull = ob.direction === "bullish";
  const inZone = price >= ob.bottom && price <= ob.top;
  const dist   = distPct(ob.mid, price);

  return (
    <div className={cn(
      "flex items-center gap-2 px-3 py-2 rounded-lg border text-[11px]",
      inZone
        ? isBull ? "bg-bull/10 border-bull/30" : "bg-bear/10 border-bear/30"
        : "bg-card/40 border-border"
    )}>
      <span className={cn(
        "size-5 rounded flex items-center justify-center text-[9px] font-bold flex-shrink-0",
        isBull ? "bg-bull/20 text-bull" : "bg-bear/20 text-bear"
      )}>
        OB
      </span>
      <div className="flex-1 min-w-0">
        <div className="mono font-semibold">{fmtPrice(ob.bottom)} – {fmtPrice(ob.top)}</div>
        <div className="text-[9px] text-muted-foreground">
          {isBull ? "بلوك شراء" : "بلوك بيع"} · {timeAgo(ob.timestamp)}
          {inZone && <span className="text-gold ml-1">● في المنطقة</span>}
        </div>
      </div>
      <div className="mono text-[10px] font-bold flex-shrink-0">{dist}%</div>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function SMCPanel({ analysis, currentPrice, interval }: Props) {
  const { trend, lastBOS, lastCHOCH, activeFVGs, activeOBs, events } = analysis;

  // Recent 6 events for timeline
  const recentEvents = useMemo(() => [...events].reverse().slice(0, 6), [events]);

  const bullFVGs = activeFVGs.filter(f => f.direction === "bullish");
  const bearFVGs = activeFVGs.filter(f => f.direction === "bearish");

  if (!lastBOS && !lastCHOCH && activeFVGs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-3 text-muted-foreground">
        <GitMerge className="size-6 text-primary" />
        <div className="text-sm text-center">
          <div>يحلل هيكل السوق...</div>
          <div className="text-[10px] mt-0.5 opacity-70">يحتاج إلى {interval} شموع كافية</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Trend + KPIs */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-border bg-card/40 p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">اتجاه الهيكل</div>
          <TrendBadge trend={trend} />
          <div className="text-[9px] text-muted-foreground mt-1">{interval} · {events.length} حدث مكتشف</div>
        </div>
        <div className={cn(
          "rounded-xl border p-3",
          lastCHOCH?.direction === "bullish" ? "bg-bull/5 border-bull/20"
          : lastCHOCH?.direction === "bearish" ? "bg-bear/5 border-bear/20"
          : "bg-card/40 border-border"
        )}>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">آخر CHOCH</div>
          {lastCHOCH ? (
            <>
              <div className="mono font-black text-lg mt-0.5">{fmtPrice(lastCHOCH.level)}</div>
              <div className={cn("text-[10px] font-semibold mt-0.5", lastCHOCH.direction === "bullish" ? "text-bull" : "text-bear")}>
                {lastCHOCH.direction === "bullish" ? "↑ انعكاس صعودي" : "↓ انعكاس هبوطي"}
              </div>
              <div className="text-[9px] text-muted-foreground">{timeAgo(lastCHOCH.timestamp)}</div>
            </>
          ) : (
            <div className="text-sm text-muted-foreground mt-1">—</div>
          )}
        </div>
        <div className={cn(
          "rounded-xl border p-3",
          lastBOS?.direction === "bullish" ? "bg-bull/5 border-bull/20"
          : lastBOS?.direction === "bearish" ? "bg-bear/5 border-bear/20"
          : "bg-card/40 border-border"
        )}>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">آخر BOS</div>
          {lastBOS ? (
            <>
              <div className="mono font-black text-lg mt-0.5">{fmtPrice(lastBOS.level)}</div>
              <div className={cn("text-[10px] font-semibold mt-0.5", lastBOS.direction === "bullish" ? "text-bull" : "text-bear")}>
                {lastBOS.direction === "bullish" ? "↑ استمرار صعود" : "↓ استمرار هبوط"}
              </div>
              <div className="text-[9px] text-muted-foreground">{timeAgo(lastBOS.timestamp)}</div>
            </>
          ) : (
            <div className="text-sm text-muted-foreground mt-1">—</div>
          )}
        </div>
      </div>

      {/* CHOCH alert (high-priority signal) */}
      {lastCHOCH && Math.abs(currentPrice - lastCHOCH.level) / lastCHOCH.level < 0.02 && (
        <div className={cn(
          "flex items-center gap-2 px-3 py-2 rounded-xl border text-[12px] font-semibold",
          lastCHOCH.direction === "bullish"
            ? "bg-bull/10 border-bull/30 text-bull"
            : "bg-bear/10 border-bear/30 text-bear"
        )}>
          <AlertTriangle className="size-4 flex-shrink-0" />
          <span>
            السعر يقترب من مستوى CHOCH {lastCHOCH.direction === "bullish" ? "الصعودي" : "الهبوطي"} ({fmtPrice(lastCHOCH.level)}) — منطقة انعكاس محتمل
          </span>
        </div>
      )}

      {/* FVGs */}
      {activeFVGs.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Layers className="size-3.5 text-primary" />
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
              فجوات القيمة العادلة (FVG) — {activeFVGs.length} نشطة
            </span>
          </div>
          <div className="space-y-2">
            {bullFVGs.length > 0 && bullFVGs.map((f, i) => <FVGRow key={`bfvg-${i}`} fvg={f} price={currentPrice} />)}
            {bearFVGs.length > 0 && bearFVGs.map((f, i) => <FVGRow key={`sfvg-${i}`} fvg={f} price={currentPrice} />)}
          </div>
        </div>
      )}

      {/* Order Blocks */}
      {activeOBs.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Layers className="size-3.5 text-gold" />
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
              بلوكات الأوامر — {activeOBs.length} فعّالة
            </span>
          </div>
          <div className="space-y-2">
            {activeOBs.map((ob, i) => <OBRow key={`ob-${i}`} ob={ob} price={currentPrice} />)}
          </div>
        </div>
      )}

      {/* Event timeline */}
      {recentEvents.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
            سجل الأحداث الهيكلية
          </div>
          <div className="space-y-1.5">
            {recentEvents.map((ev, i) => {
              const isBull = ev.direction === "bullish";
              const isCHOCH = ev.kind === "CHOCH";
              return (
                <div key={i} className="flex items-center gap-3 text-[11px]">
                  {/* Icon */}
                  <div className={cn(
                    "size-6 rounded flex items-center justify-center text-[9px] font-black flex-shrink-0",
                    isCHOCH
                      ? isBull ? "bg-bull/25 text-bull" : "bg-bear/25 text-bear"
                      : isBull ? "bg-bull/10 text-bull/70" : "bg-bear/10 text-bear/70"
                  )}>
                    {ev.kind}
                  </div>
                  {/* Direction */}
                  <span className={cn("w-4 text-center", isBull ? "text-bull" : "text-bear")}>
                    {isBull ? "↑" : "↓"}
                  </span>
                  {/* Level */}
                  <span className="mono font-semibold">{fmtPrice(ev.level)}</span>
                  {/* Time */}
                  <span className="text-muted-foreground text-[9px] ml-auto">{timeAgo(ev.timestamp)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
