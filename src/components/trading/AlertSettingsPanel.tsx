import { SYMBOLS } from "@/lib/binance";
import { useSession } from "@/lib/session-store";
import { Bell, BellOff, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function AlertSettingsPanel() {
  const a = useSession((s) => s.alertSettings);
  const set = useSession((s) => s.setAlertSettings);

  const toggleSym = (sym: string) => {
    const cur = new Set(a.symbols);
    cur.has(sym) ? cur.delete(sym) : cur.add(sym);
    set({ symbols: [...cur] });
  };

  return (
    <div className="rounded-2xl border border-border bg-card/40 p-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          {a.enabled ? <Bell className="size-4 text-primary" /> : <BellOff className="size-4 text-muted-foreground" />}
          نظام التنبيهات
        </div>
        <label className="text-[11px] mono flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={a.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
            className="accent-primary"
          />
          مُفعَّل
        </label>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] mono">
        <F label="عتبة الجدار ($)">
          <N v={a.wallUsdThreshold} step={50_000} onChange={(v) => set({ wallUsdThreshold: v })} />
        </F>
        <F label="عتبة الاختلال (0-1)">
          <N v={a.imbalanceThreshold} step={0.05} min={0} max={1} onChange={(v) => set({ imbalanceThreshold: v })} />
        </F>
        <F label="احتمالية الستوب %">
          <N v={a.stopHuntProbThreshold} step={1} min={0} max={100} onChange={(v) => set({ stopHuntProbThreshold: v })} />
        </F>
        <F label="فترة التهدئة (ث)">
          <N v={a.cooldownSec} step={5} min={5} onChange={(v) => set({ cooldownSec: v })} />
        </F>
      </div>

      <div className="mt-3">
        <div className="text-[11px] text-muted-foreground mb-1.5">
          الأزواج المراقبة {a.symbols.length === 0 && "(الكل)"}
        </div>
        <div className="flex flex-wrap gap-1">
          {SYMBOLS.map((sym) => {
            const active = a.symbols.length === 0 || a.symbols.includes(sym);
            return (
              <button
                key={sym}
                onClick={() => toggleSym(sym)}
                className={cn(
                  "text-[10px] mono px-2 py-1 rounded border transition",
                  active
                    ? "border-primary/50 bg-primary/15 text-primary"
                    : "border-border bg-card/40 text-muted-foreground hover:text-foreground"
                )}
              >
                {sym.replace("USDT", "")}
              </button>
            );
          })}
          {a.symbols.length > 0 && (
            <button
              onClick={() => set({ symbols: [] })}
              className="text-[10px] mono px-2 py-1 rounded border border-border bg-card/40 text-muted-foreground hover:text-foreground"
            >
              <Trash2 className="size-3 inline" /> مسح التحديد
            </button>
          )}
        </div>
      </div>

      <label className="mt-3 inline-flex items-center gap-1.5 text-[11px] mono cursor-pointer">
        <input
          type="checkbox"
          checked={a.sound}
          onChange={(e) => set({ sound: e.target.checked })}
          className="accent-primary"
        />
        صوت تنبيه
      </label>
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
function N({
  v, onChange, step = 1, min, max,
}: { v: number; onChange: (n: number) => void; step?: number; min?: number; max?: number }) {
  return (
    <input
      type="number"
      value={v}
      step={step}
      min={min}
      max={max}
      onChange={(e) => onChange(+e.target.value)}
      className="w-full bg-background border border-border rounded px-2 py-1 mono"
    />
  );
}
