import { useEffect, useState } from "react";
import { useSession } from "@/lib/session-store";
import { Bell, X, AlertTriangle, Activity, Crosshair } from "lucide-react";
import { cn } from "@/lib/utils";

export function AlertsCenter() {
  const alerts = useSession((s) => s.alerts);
  const unread = useSession((s) => s.unreadAlerts);
  const markRead = useSession((s) => s.markAlertsRead);
  const clear = useSession((s) => s.clearAlerts);
  const [open, setOpen] = useState(false);

  // also show transient toast for newest critical
  const [toast, setToast] = useState<typeof alerts[number] | null>(null);
  useEffect(() => {
    const a = alerts[0];
    if (a && Date.now() - a.time < 3000) {
      setToast(a);
      const t = setTimeout(() => setToast(null), 4500);
      return () => clearTimeout(t);
    }
  }, [alerts]);

  return (
    <>
      <button
        onClick={() => {
          setOpen((v) => !v);
          markRead();
        }}
        className="relative inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border bg-card/60 hover:bg-card text-xs mono"
      >
        <Bell className="size-3.5" />
        التنبيهات
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 size-4 rounded-full bg-bear text-white text-[9px] flex items-center justify-center font-bold">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute z-40 top-full right-0 mt-2 w-[360px] max-h-[480px] overflow-y-auto rounded-2xl border border-border bg-background/95 backdrop-blur shadow-2xl p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold text-sm">مركز التنبيهات</div>
            <div className="flex items-center gap-2">
              <button
                onClick={clear}
                className="text-[10px] mono text-muted-foreground hover:text-bear"
              >
                مسح الكل
              </button>
              <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
                <X className="size-4" />
              </button>
            </div>
          </div>

          {alerts.length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-6">
              لا توجد تنبيهات بعد
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            {alerts.map((a) => (
              <AlertRow key={a.id} a={a} />
            ))}
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-4 left-4 z-50 max-w-sm rounded-xl border border-border bg-background/95 backdrop-blur shadow-2xl p-3 animate-in slide-in-from-bottom-2">
          <AlertRow a={toast} />
        </div>
      )}
    </>
  );
}

function AlertRow({ a }: { a: ReturnType<typeof useSession.getState>["alerts"][number] }) {
  const Icon =
    a.type === "wall" ? AlertTriangle : a.type === "imbalance" ? Activity : Crosshair;
  const tone =
    a.severity === "critical"
      ? "border-bear/50 bg-bear/10 text-bear"
      : a.severity === "warn"
      ? "border-gold/50 bg-gold/10 text-gold"
      : "border-primary/40 bg-primary/10 text-primary";
  return (
    <div className={cn("rounded-lg border p-2 text-xs", tone)}>
      <div className="flex items-center justify-between font-semibold">
        <span className="flex items-center gap-1.5">
          <Icon className="size-3.5" /> {a.title}
        </span>
        <span className="mono text-[10px] opacity-75">{a.symbol}</span>
      </div>
      <div className="mt-1 text-foreground/90 mono text-[11px]">{a.detail}</div>
      <div className="text-[10px] mono text-muted-foreground mt-1">
        {new Date(a.time).toLocaleTimeString()}
      </div>
    </div>
  );
}
