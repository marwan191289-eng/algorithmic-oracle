import { useSession } from "@/lib/session-store";
import { ShieldAlert } from "lucide-react";

export function QualityAlertPanel() {
  const cfg = useSession((s) => s.qualityAlert);
  const set = useSession((s) => s.setQualityAlert);
  return (
    <div className="rounded-2xl border border-border bg-card/40 p-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ShieldAlert className="size-4 text-primary" />
          تنبيهات تدهور الجودة (مبنية على الانحدار)
        </div>
        <label className="text-[11px] mono flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={cfg.enabled}
                 onChange={(e) => set({ enabled: e.target.checked })}
                 className="accent-primary" />
          مُفعَّل
        </label>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] mono">
        <F label="ميل الهبوط /دقيقة ≥">
          <N v={cfg.slopePerMin} step={0.1} min={0.1}
             onChange={(v) => set({ slopePerMin: v })} />
        </F>
        <F label="حد الدقة الحديثة">
          <N v={cfg.scoreFloor} step={1} min={20} max={100}
             onChange={(v) => set({ scoreFloor: v })} />
        </F>
        <F label="مدة التأكيد (ث)">
          <N v={cfg.confirmSec} step={5} min={5}
             onChange={(v) => set({ confirmSec: v })} />
        </F>
        <F label="فترة التهدئة (ث)">
          <N v={cfg.cooldownSec} step={10} min={30}
             onChange={(v) => set({ cooldownSec: v })} />
        </F>
      </div>
      <div className="text-[10px] text-muted-foreground mt-2">
        لا يُرسل التنبيه إلا عند استمرار الميل السلبي وانخفاض الدقة لمدة التأكيد كاملة — يتجاهل التذبذبات اللحظية.
      </div>
    </div>
  );
}

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
function N({ v, onChange, step = 1, min, max }: {
  v: number; onChange: (n: number) => void; step?: number; min?: number; max?: number;
}) {
  return (
    <input type="number" value={v} step={step} min={min} max={max}
      onChange={(e) => onChange(+e.target.value)}
      className="w-full bg-background border border-border rounded px-2 py-1 mono" />
  );
}
