import { DEFAULT_WALL_SETTINGS, useSession, type WallMethod } from "@/lib/session-store";
import { Settings2, RotateCcw } from "lucide-react";

export function WallSettingsPanel() {
  const s = useSession((st) => st.wallSettings);
  const set = useSession((st) => st.setWallSettings);
  const reset = useSession((st) => st.resetWallSettings);

  return (
    <div className="rounded-2xl border border-border bg-card/40 p-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Settings2 className="size-4 text-primary" /> إعدادات كشف الجدران
        </div>
        <button
          onClick={reset}
          className="text-[11px] mono flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="size-3" /> افتراضي
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-[11px] mono">
        <Field label="طريقة التجميع">
          <select
            value={s.method}
            onChange={(e) => set({ method: e.target.value as WallMethod })}
            className="w-full bg-background border border-border rounded px-1.5 py-1"
          >
            <option value="zscore">Z-Score (إحصائي)</option>
            <option value="percentile">المئين العلوي</option>
            <option value="absolute">عتبة مطلقة (USD)</option>
          </select>
        </Field>
        <Field label="عمق المستويات">
          <Num value={s.depth} min={20} max={500} step={10} onChange={(v) => set({ depth: v })} />
        </Field>
        <Field label="حد أعلى للجدران/جهة">
          <Num value={s.maxPerSide} min={1} max={20} step={1} onChange={(v) => set({ maxPerSide: v })} />
        </Field>

        {s.method === "zscore" && (
          <Field label="عتبة Z-Score">
            <Num value={s.zThreshold} min={1} max={6} step={0.1} onChange={(v) => set({ zThreshold: v })} />
          </Field>
        )}
        {s.method === "percentile" && (
          <Field label="المئين %">
            <Num value={s.percentile} min={50} max={99.9} step={0.5} onChange={(v) => set({ percentile: v })} />
          </Field>
        )}
        {s.method === "absolute" && (
          <Field label="عتبة USD">
            <Num value={s.absoluteUsd} min={10_000} max={50_000_000} step={10_000} onChange={(v) => set({ absoluteUsd: v })} />
          </Field>
        )}
      </div>

      <div className="mt-2 text-[10px] text-muted-foreground mono">
        القيم المُطبَّقة الآن: عمق={s.depth} · طريقة={s.method}
        {s.method === "zscore" && ` · z≥${s.zThreshold}`}
        {s.method === "percentile" && ` · p${s.percentile}`}
        {s.method === "absolute" && ` · ≥$${s.absoluteUsd.toLocaleString()}`}
        {" · افتراضي: z="}{DEFAULT_WALL_SETTINGS.zThreshold}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function Num({
  value, min, max, step, onChange,
}: { value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(+e.target.value)}
      className="w-full bg-background border border-border rounded px-2 py-1 mono"
    />
  );
}
