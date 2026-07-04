import { useState } from "react";
import { REGIME_WEIGHTS, type InstitutionalVerdictV2 } from "@/lib/analysis";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp, Crosshair, Target, Info } from "lucide-react";

export function ScoreBreakdown({ v }: { v: InstitutionalVerdictV2 }) {
  const [open, setOpen] = useState(false);
  const regime = v.compositeScore?.regime ?? "ranging";
  const rw = REGIME_WEIGHTS[regime];
  const weights: { key: keyof InstitutionalVerdictV2["components"]; label: string; w: number; anchor?: string }[] = [
    { key: "bookImbalance",     label: "اختلال دفتر الأوامر", w: rw.book },
    { key: "proximityPressure", label: "ضغط الجدران (مرجَّح بالقرب)", w: rw.wall, anchor: "#walls-panel" },
    { key: "momentum",          label: "الزخم الخطّي", w: rw.mom },
    { key: "microDrift",        label: "انجراف السعر الميكروي", w: rw.micro },
    { key: "volumeTrend",       label: "اتجاه الحجم", w: rw.vol },
    { key: "rsiPenalty",        label: "RSI mean-reversion", w: rw.rsi },
  ];

  // why no trade?
  const gates: string[] = [];
  if (Math.abs(v.score) < 25) gates.push(`|الدرجة| < 25 (الحالية ${v.score})`);
  if (v.confidence < 55) gates.push(`الثقة < 55% (الحالية ${v.confidence}%)`);
  if (v.components.spreadHealth < 0.4) gates.push(`السبريد/التقلّب غير صحي (${(v.components.spreadHealth*100).toFixed(0)}%)`);

  // contributions (raw component × weight × 100, before tanh)
  const contribs = weights.map((w) => ({
    ...w,
    val: (v.components as any)[w.key] as number,
    contribution: ((v.components as any)[w.key] as number) * w.w * 100,
  }));
  const totalAbs = contribs.reduce((s, c) => s + Math.abs(c.contribution), 0) || 1;

  return (
    <div className="rounded-xl border border-border bg-secondary/30">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3 py-2 flex items-center justify-between text-[12px] font-semibold"
      >
        <span className="flex items-center gap-1.5"><Info className="size-3.5 text-primary" /> لماذا هذه الدرجة؟ — شرح تفصيلي</span>
        {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3">
          <div className="text-[11px] text-muted-foreground">
            الدرجة النهائية ناتجة عن مجموع مرجَّح للمكوّنات الستة، ثم تنعيم EMA، وأخيراً
            تعديل بصحة السبريد وحالة السوق ({regime}). النسب أدناه تُظهر إسهام كل مكوّن في الدرجة.
          </div>

          {/* Contribution bars */}
          <div className="space-y-1.5">
            {contribs.map((c) => {
              const pct = (Math.abs(c.contribution) / totalAbs) * 100;
              const pos = c.contribution >= 0;
              return (
                <div key={c.key} className="text-[11px] mono">
                  <div className="flex justify-between mb-0.5">
                    <span className="text-foreground">
                      {c.label}
                      {c.anchor && (
                        <a href={c.anchor} className="ml-1 inline-flex items-center gap-0.5 text-primary hover:underline text-[10px]">
                          <Crosshair className="size-3" /> اذهب
                        </a>
                      )}
                      <span className="text-muted-foreground mr-1"> · وزن {(c.w*100).toFixed(0)}%</span>
                    </span>
                    <span className={pos ? "text-bull" : "text-bear"}>
                      {pos ? "+" : ""}{c.contribution.toFixed(1)} ({(c.val*100).toFixed(0)})
                    </span>
                  </div>
                  <div className="h-1.5 rounded bg-background/60 overflow-hidden flex">
                    {!pos && (
                      <div className="bg-bear/70 h-full" style={{ width: `${pct}%`, marginLeft: "auto" }} />
                    )}
                    {pos && <div className="bg-bull/70 h-full" style={{ width: `${pct}%` }} />}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Confidence + raw before EMA */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-[11px] mono pt-1 border-t border-border">
            <Mini label="الدرجة قبل التنعيم" value={`${v.scoreRaw >= 0 ? "+" : ""}${v.scoreRaw}`} />
            <Mini label="الدرجة بعد EMA" value={`${v.score >= 0 ? "+" : ""}${v.score}`}
                  tone={v.score > 25 ? "bull" : v.score < -25 ? "bear" : "neutral"} />
            <Mini label="النظام" value={regime} />
            <Mini label="ثقة الإشارة" value={`${v.confidence}%`}
                  tone={v.confidence >= 70 ? "bull" : v.confidence >= 55 ? "neutral" : "bear"} />
          </div>

          {/* Trade gate explanation */}
          <div className={cn(
            "rounded-md border p-2 text-[11px]",
            v.targets.side === "none"
              ? "border-gold/30 bg-gold/5 text-gold"
              : "border-bull/30 bg-bull/5 text-bull"
          )}>
            <div className="flex items-center gap-1.5 font-semibold mb-1">
              <Target className="size-3.5" />
              {v.targets.side === "none" ? "لماذا لا توجد خطة تداول؟" : "لماذا تم توليد خطة تداول؟"}
            </div>
            {v.targets.side === "none" ? (
              gates.length ? (
                <ul className="space-y-0.5 mr-3 list-disc text-foreground/80">
                  {gates.map((g, i) => <li key={i}>{g}</li>)}
                </ul>
              ) : (
                <div>لا تتوفر شروط (إشارة ≥25 + ثقة ≥55%) في هذه اللحظة.</div>
              )
            ) : (
              <div className="text-foreground/80">
                توافرت العتبات: |الدرجة|≥25 ({v.score})، الثقة ≥55% ({v.confidence}%).
                الستوب يُحسب خلف <a href="#walls-panel" className="underline">أقرب جدار</a> أو
                مضاعف ATR، والأهداف عند 1.5× و3× ATR.
              </div>
            )}
          </div>

          <div className="text-[10px] text-muted-foreground border-t border-border pt-2 flex gap-3 flex-wrap">
            <a href="#walls-panel" className="text-primary hover:underline">↗ الجدران السعرية</a>
            <a href="#zones-panel" className="text-primary hover:underline">↗ مناطق صيد الستوبات</a>
            <a href="#whaleeye-chart" className="text-primary hover:underline">↗ الرسم البياني</a>
          </div>
        </div>
      )}
    </div>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: "bull" | "bear" | "neutral" }) {
  return (
    <div className="rounded border border-border bg-card/40 px-2 py-1.5 flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-bold",
        tone === "bull" && "text-bull",
        tone === "bear" && "text-bear",
      )}>{value}</span>
    </div>
  );
}
