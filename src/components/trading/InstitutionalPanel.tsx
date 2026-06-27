import type { InstitutionalVerdict, InstitutionalVerdictV2 } from "@/lib/analysis";
import { cn } from "@/lib/utils";
import { Brain, Activity, Waves, Fish, Target, ShieldAlert } from "lucide-react";
import { fmtPrice } from "@/lib/binance";
import { ScoreBreakdown } from "./ScoreBreakdown";

const BIAS_COLORS: Record<InstitutionalVerdict["bias"], string> = {
  "strong-bull": "text-bull glow-bull border-bull/40",
  bull: "text-bull border-bull/30",
  neutral: "text-gold border-gold/30",
  bear: "text-bear border-bear/30",
  "strong-bear": "text-bear glow-bear border-bear/40",
};

export function InstitutionalPanel({ verdict }: { verdict: InstitutionalVerdict | InstitutionalVerdictV2 }) {
  const v2 = (verdict as InstitutionalVerdictV2);
  const hasV2 = typeof v2.confidence === "number";
  const pct = (verdict.score + 100) / 2; // 0..100
  return (
    <div className="rounded-2xl border border-border bg-card/60 p-5 glass space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="size-11 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center">
            <Brain className="size-5 text-primary" />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em] text-primary">
              المحرك المؤسساتي
            </div>
            <div className="text-lg font-bold text-foreground">
              خوارزمية تفكير الحيتان
            </div>
          </div>
        </div>
        <WhaleBadge side={verdict.whaleSide} />
      </div>

      {/* Score gauge */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">المؤشر المركّب</span>
          <span
            className={cn(
              "mono text-4xl font-extrabold",
              verdict.score > 25
                ? "text-bull"
                : verdict.score < -25
                ? "text-bear"
                : "text-gold"
            )}
          >
            {verdict.score > 0 ? "+" : ""}
            {verdict.score}
          </span>
        </div>
        <div className="h-3 rounded-full overflow-hidden bg-secondary relative">
          <div
            className="absolute inset-y-0 left-0 bg-gradient-to-r from-bear via-gold to-bull"
            style={{ width: "100%", opacity: 0.35 }}
          />
          <div
            className="absolute top-1/2 -translate-y-1/2 size-4 rounded-full bg-foreground border-2 border-background shadow-lg transition-all"
            style={{ left: `calc(${pct}% - 8px)` }}
          />
          <div className="absolute inset-y-0 left-1/2 w-px bg-foreground/20" />
        </div>
        <div className="flex justify-between text-[10px] mono text-muted-foreground">
          <span>هابط قوي -100</span>
          <span>محايد 0</span>
          <span>صاعد قوي +100</span>
        </div>
      </div>

      {/* Verdict */}
      <div
        className={cn(
          "rounded-xl border p-3 text-center font-bold text-base",
          BIAS_COLORS[verdict.bias]
        )}
      >
        {verdict.label}
      </div>

      {/* Confidence + Trade plan (V2) */}
      {hasV2 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <div className="rounded-xl border border-border bg-card/40 p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">ثقة الإشارة</div>
            <div className={cn(
              "mono font-bold text-2xl",
              v2.confidence >= 70 ? "text-bull" : v2.confidence >= 50 ? "text-gold" : "text-bear"
            )}>{v2.confidence}%</div>
            <div className="text-[10px] mono text-muted-foreground mt-1">
              إجماع المكوّنات: {v2.agreement >= 0 ? "+" : ""}{v2.agreement}
            </div>
          </div>
          <div className={cn(
            "rounded-xl border p-3",
            v2.targets.side === "long" ? "border-bull/30 bg-bull/5"
            : v2.targets.side === "short" ? "border-bear/30 bg-bear/5"
            : "border-border bg-card/40"
          )}>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
              <Target className="size-3" /> خطة التداول (ATR)
            </div>
            {v2.targets.side === "none" ? (
              <div className="text-sm text-muted-foreground mt-1">لا توجد إشارة كافية</div>
            ) : (
              <div className="mono text-[11px] mt-1 space-y-0.5">
                <div>الاتجاه: <span className="font-bold">{v2.targets.side === "long" ? "شراء" : "بيع"}</span> · R:R = {v2.targets.rr}</div>
                <div>دخول: {fmtPrice(v2.targets.entry)}</div>
                <div>هدف 1: <span className="text-bull">{fmtPrice(v2.targets.tp1)}</span> · هدف 2: <span className="text-bull">{fmtPrice(v2.targets.tp2)}</span></div>
                <div className="flex items-center gap-1">
                  <ShieldAlert className="size-3 text-bear" />
                  ستوب: <span className="text-bear">{fmtPrice(v2.targets.stop)}</span>
                </div>
              </div>
            )}
          </div>
          <div className="rounded-xl border border-border bg-card/40 p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">قراءة ميكروية</div>
            <div className="mono text-[11px] mt-1 space-y-0.5">
              <div>انجراف ميكرو: <span className={v2.components.microDrift > 0 ? "text-bull" : "text-bear"}>{(v2.components.microDrift * 100).toFixed(0)}</span></div>
              <div>قرب الجدران: <span className={v2.components.proximityPressure > 0 ? "text-bull" : "text-bear"}>{(v2.components.proximityPressure * 100).toFixed(0)}</span></div>
              <div>تخفيف RSI: <span className={v2.components.rsiPenalty > 0 ? "text-bull" : v2.components.rsiPenalty < 0 ? "text-bear" : "text-muted-foreground"}>{(v2.components.rsiPenalty * 100).toFixed(0)}</span></div>
              {typeof v2.scoreRaw === "number" && (
                <div className="text-muted-foreground">قبل التنعيم: {v2.scoreRaw > 0 ? "+" : ""}{v2.scoreRaw}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Components */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <Comp label="دفتر الأوامر" value={verdict.components.bookImbalance} />
        <Comp label="ضغط الجدران" value={verdict.components.wallPressure} />
        <Comp label="الزخم" value={verdict.components.momentum} />
        <Comp label="اتجاه الحجم" value={verdict.components.volumeTrend} />
        <Comp
          label="صحة الفارق"
          value={verdict.components.spreadHealth}
          unsigned
        />
      </div>

      {hasV2 && <ScoreBreakdown v={v2} />}

      {/* Reasoning */}
      <div className="rounded-xl border border-border bg-secondary/30 p-3 space-y-1.5">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
          <Activity className="size-3.5 text-primary" />
          الأدلة الحسابية
        </div>
        <ul className="space-y-1 text-[12px] text-foreground/90">
          {verdict.reasoning.map((r, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-primary mt-0.5">▸</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Comp({
  label,
  value,
  unsigned = false,
}: {
  label: string;
  value: number;
  unsigned?: boolean;
}) {
  const v = unsigned ? value : value;
  const display = unsigned
    ? `${Math.round(v * 100)}%`
    : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}`;
  const color = unsigned
    ? "text-primary"
    : v > 0.15
    ? "text-bull"
    : v < -0.15
    ? "text-bear"
    : "text-muted-foreground";
  return (
    <div className="rounded-lg border border-border bg-card/40 p-2 text-center">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={cn("mono font-bold text-lg", color)}>{display}</div>
    </div>
  );
}

function WhaleBadge({ side }: { side: InstitutionalVerdict["whaleSide"] }) {
  const map = {
    buyers: { label: "حيتان شراء", cls: "text-bull border-bull/40 bg-bull/10", icon: Fish },
    sellers: { label: "حيتان بيع", cls: "text-bear border-bear/40 bg-bear/10", icon: Fish },
    balanced: { label: "توازن", cls: "text-gold border-gold/40 bg-gold/10", icon: Waves },
  } as const;
  const m = map[side];
  const Icon = m.icon;
  return (
    <div className={cn("rounded-lg border px-3 py-1.5 flex items-center gap-2 text-xs font-semibold", m.cls)}>
      <Icon className="size-3.5" />
      {m.label}
    </div>
  );
}
