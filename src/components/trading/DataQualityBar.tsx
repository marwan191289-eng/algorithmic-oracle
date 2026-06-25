import { useSession } from "@/lib/session-store";
import { cn } from "@/lib/utils";
import { Activity, AlertTriangle, ShieldCheck, Wifi, WifiOff } from "lucide-react";

export function DataQualityBar({ symbol }: { symbol: string }) {
  const q = useSession((s) => s.quality.bySymbol[symbol]);
  const blockOnLow = useSession((s) => s.quality.blockOnLowQuality);
  const minScore = useSession((s) => s.quality.minAcceptableScore);
  const setBlock = useSession((s) => s.setBlockOnLowQuality);
  const setMin = useSession((s) => s.setMinAcceptableScore);

  const score = q?.score ?? 0;
  const level = q?.level ?? "poor";
  const tone =
    level === "excellent"
      ? "text-bull border-bull/40 bg-bull/10"
      : level === "good"
      ? "text-bull/80 border-bull/30 bg-bull/5"
      : level === "degraded"
      ? "text-gold border-gold/40 bg-gold/10"
      : "text-bear border-bear/40 bg-bear/10";

  return (
    <div className="rounded-2xl border border-border bg-card/40 p-3">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="size-4 text-primary" />
          وضع التدقيق — جودة بيانات Binance
        </div>
        <div className="flex items-center gap-2 text-[11px] mono">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={blockOnLow}
              onChange={(e) => setBlock(e.target.checked)}
              className="accent-primary"
            />
            <span>حجب التحليل عند الجودة المنخفضة</span>
          </label>
          <span className="text-muted-foreground">| الحد الأدنى:</span>
          <input
            type="number"
            min={0}
            max={100}
            value={minScore}
            onChange={(e) => setMin(Math.max(0, Math.min(100, +e.target.value)))}
            className="w-14 bg-background border border-border rounded px-1.5 py-0.5 mono text-center"
          />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-2 text-[11px] mono">
        <QChip
          icon={q?.connected ? <Wifi className="size-3" /> : <WifiOff className="size-3" />}
          label="الاتصال"
          value={q?.connected ? "حي" : "منقطع"}
          tone={q?.connected ? "ok" : "bad"}
        />
        <QChip label="التحديث" value={`${(q?.updateRateHz ?? 0).toFixed(1)} Hz`} />
        <QChip
          label="التأخر"
          value={`${(q?.latencyMs ?? 0).toFixed(0)} ms`}
          tone={
            (q?.latencyMs ?? 0) < 250 ? "ok" : (q?.latencyMs ?? 0) < 600 ? "warn" : "bad"
          }
        />
        <QChip label="انقطاعات" value={`${q?.disconnects ?? 0}`} tone={(q?.disconnects ?? 0) > 0 ? "warn" : "ok"} />
        <div className={cn("rounded-md border px-2 py-1.5 flex items-center justify-between", tone)}>
          <span className="opacity-80">الدقة</span>
          <span className="font-bold flex items-center gap-1">
            {level === "poor" ? <AlertTriangle className="size-3" /> : <ShieldCheck className="size-3" />}
            {score}/100
          </span>
        </div>
      </div>
    </div>
  );
}

function QChip({
  label,
  value,
  icon,
  tone = "neutral",
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  tone?: "ok" | "warn" | "bad" | "neutral";
}) {
  const cls =
    tone === "ok"
      ? "text-bull border-bull/30"
      : tone === "warn"
      ? "text-gold border-gold/30"
      : tone === "bad"
      ? "text-bear border-bear/30"
      : "text-foreground border-border";
  return (
    <div className={cn("rounded-md border px-2 py-1.5 flex items-center justify-between bg-card/30", cls)}>
      <span className="opacity-70 flex items-center gap-1">{icon}{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

export function QualityBlockNotice({ symbol }: { symbol: string }) {
  const q = useSession((s) => s.quality.bySymbol[symbol]);
  const min = useSession((s) => s.quality.minAcceptableScore);
  return (
    <div className="rounded-2xl border border-bear/40 bg-bear/10 p-6 text-center">
      <AlertTriangle className="size-8 text-bear mx-auto mb-2" />
      <div className="font-bold text-lg">تم حجب عرض النتائج — جودة البيانات منخفضة</div>
      <div className="text-sm text-muted-foreground mt-1 mono">
        الدقة الحالية {q?.score ?? 0}/100 · الحد المطلوب {min}/100 · {q?.connected ? "متصل" : "غير متصل"} ·
        {" "}تأخر {(q?.latencyMs ?? 0).toFixed(0)}ms · تحديث {(q?.updateRateHz ?? 0).toFixed(1)}Hz
      </div>
      <div className="text-xs text-muted-foreground mt-3">
        ستظهر النتائج تلقائياً عند تحسن الاتصال، أو يمكنك إيقاف الحجب من شريط التدقيق أعلاه.
      </div>
    </div>
  );
}
