import { useState, useEffect, useRef } from "react";
import type { InstitutionalVerdictV2 } from "@/lib/analysis";
import type { BookMetrics } from "@/lib/analysis";
import { cn } from "@/lib/utils";
import { Bot, Power, TrendingUp, TrendingDown, Minus, Activity, Database, Cpu } from "lucide-react";
import { fmtPrice } from "@/lib/binance";

// ── Types ──────────────────────────────────────────────────────────────────
type RLAction = "LONG" | "SHORT" | "HOLD";

interface AgentDecision {
  action: RLAction;
  confidence: number;
  score: number;
  timestamp: number;
  entry: number;
}

// ── Policy (rule-based PPO approximation) ──────────────────────────────────
// Simulates what a trained PPO agent would output given the institutional state
// vector. Requires multi-signal agreement for directional trades.
function runPolicy(v: InstitutionalVerdictV2): { action: RLAction; policyConf: number } {
  const { score, confidence, components } = v;

  const bullCount = [
    components.bookImbalance > 0.08,
    components.proximityPressure > 0.05,
    components.momentum > 0.05,
    components.microDrift > 0,
    components.volumeTrend > 0,
  ].filter(Boolean).length;

  const bearCount = [
    components.bookImbalance < -0.08,
    components.proximityPressure < -0.05,
    components.momentum < -0.05,
    components.microDrift < 0,
    components.volumeTrend < 0,
  ].filter(Boolean).length;

  // Stricter entry: need score conviction + confidence + signal majority
  if (score >= 28 && confidence >= 55 && bullCount >= 3) {
    const policyConf = Math.min(95, Math.round(confidence * 0.7 + bullCount * 5));
    return { action: "LONG", policyConf };
  }
  if (score <= -28 && confidence >= 55 && bearCount >= 3) {
    const policyConf = Math.min(95, Math.round(confidence * 0.7 + bearCount * 5));
    return { action: "SHORT", policyConf };
  }
  const holdConf = Math.round(40 + Math.min(35, (5 - Math.max(bullCount, bearCount)) * 7));
  return { action: "HOLD", policyConf: holdConf };
}

// ── State vector builder ───────────────────────────────────────────────────
function buildStateVector(v: InstitutionalVerdictV2, metrics: BookMetrics) {
  return {
    score:              +(v.score / 100).toFixed(3),
    confidence:         +(v.confidence / 100).toFixed(3),
    bookImbalance:      +v.components.bookImbalance.toFixed(3),
    proximityPressure:  +v.components.proximityPressure.toFixed(3),
    microDrift:         +v.components.microDrift.toFixed(3),
    momentum:           +v.components.momentum.toFixed(3),
    volumeTrend:        +v.components.volumeTrend.toFixed(3),
    rsiPenalty:         +v.components.rsiPenalty.toFixed(3),
    spreadPct:          +(metrics.spreadPct).toFixed(4),
    wallImbalance:      +v.components.wallPressure.toFixed(3),
  };
}

// ── Main Component ─────────────────────────────────────────────────────────
export function RLAgentPanel({
  verdict,
  metrics,
}: {
  verdict: InstitutionalVerdictV2 | null;
  metrics: BookMetrics | null;
}) {
  const [active, setActive] = useState(false);
  const [current, setCurrent] = useState<AgentDecision | null>(null);
  const [log, setLog] = useState<AgentDecision[]>([]);
  const prevActionRef = useRef<RLAction | null>(null);

  useEffect(() => {
    if (!active || !verdict || !metrics) return;
    const { action, policyConf } = runPolicy(verdict);

    // Only log if action changed, to avoid log spam
    const changed = action !== prevActionRef.current;
    prevActionRef.current = action;

    const decision: AgentDecision = {
      action,
      confidence: policyConf,
      score: verdict.score,
      timestamp: Date.now(),
      entry: metrics.mid,
    };
    setCurrent(decision);
    if (changed) {
      setLog((prev) => [decision, ...prev].slice(0, 8));
    }
  }, [verdict, metrics, active]);

  // Reset on deactivate
  useEffect(() => {
    if (!active) {
      setCurrent(null);
      prevActionRef.current = null;
    }
  }, [active]);

  const stateVector =
    active && verdict && metrics ? buildStateVector(verdict, metrics) : null;
  const featureCount = stateVector ? Object.keys(stateVector).length : 0;

  return (
    <div className="rounded-2xl border border-border bg-card/60 glass overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-border bg-card/70">
        <div className="flex items-center gap-2.5">
          <div className={cn(
            "size-9 rounded-xl flex items-center justify-center transition-colors",
            active ? "bg-primary/20 border border-primary/40" : "bg-muted/20 border border-border"
          )}>
            <Bot className={cn("size-4", active ? "text-primary" : "text-muted-foreground")} />
          </div>
          <div>
            <div className="font-bold text-sm">ربط RL Agent</div>
            <div className="text-[10px] text-muted-foreground">Policy / PPO · Execution Layer</div>
          </div>
        </div>
        <button
          onClick={() => setActive((v) => !v)}
          className={cn(
            "flex items-center gap-2 px-3 py-1.5 rounded-xl text-[11px] font-semibold border transition-all",
            active
              ? "bg-primary/15 border-primary/40 text-primary hover:bg-primary/20"
              : "bg-card/50 border-border text-muted-foreground hover:text-foreground hover:border-accent"
          )}
        >
          <Power className="size-3.5" />
          {active ? "إيقاف" : "تفعيل"}
        </button>
      </header>

      <div className="p-4 space-y-4">
        {/* Status grid */}
        <div className="grid grid-cols-3 gap-3">
          <StatusCard
            label="حالة الوكيل"
            value={active ? "نشط" : "غير متصل"}
            sub={active ? "Policy Running" : "Standby"}
            active={active}
          />
          <ActionCard action={active ? current?.action ?? null : null} />
          <ConfidenceCard confidence={active ? current?.confidence ?? null : null} />
        </div>

        {/* State vector row */}
        {active && stateVector ? (
          <div className="rounded-xl border border-border bg-secondary/30 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                <Database className="size-3.5 text-primary" />
                متجه الحالة — State Vector
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] mono bg-primary/15 text-primary border border-primary/30 px-2 py-0.5 rounded-full">
                  {featureCount} features
                </span>
                <span className="text-[10px] mono text-muted-foreground border border-border px-2 py-0.5 rounded-full">
                  JSON
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
              {Object.entries(stateVector).map(([k, v]) => (
                <StateFeature key={k} name={k} value={v as number} />
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-border p-3 text-center text-[12px] text-muted-foreground">
            فعّل الوكيل لرؤية متجه الحالة وقراءات السياسة
          </div>
        )}

        {/* Decision log */}
        {log.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              <Activity className="size-3.5 text-primary" />
              سجل القرارات
            </div>
            <div className="space-y-1 max-h-44 overflow-y-auto">
              {log.map((d, i) => (
                <LogRow key={d.timestamp} decision={d} isCurrent={i === 0} />
              ))}
            </div>
          </div>
        )}

        {/* Architecture note */}
        <div className="rounded-xl border border-border bg-secondary/20 px-3 py-2.5 flex items-start gap-2.5">
          <Cpu className="size-3.5 text-muted-foreground mt-0.5 flex-shrink-0" />
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            الوكيل الحالي <span className="text-foreground font-medium">قائم على القواعد (Rule-Based Policy)</span> يحاكي سلوك PPO. ربط نموذج حقيقي يتم عبر استدعاء <code className="mono text-primary text-[10px] bg-primary/10 px-1 rounded">/api/rl/action</code> وإرسال متجه الحالة أعلاه بصيغة JSON.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function StatusCard({ label, value, sub, active }: { label: string; value: string; sub: string; active: boolean }) {
  return (
    <div className={cn(
      "rounded-xl border p-3 transition-colors",
      active ? "border-primary/30 bg-primary/5" : "border-border bg-card/40"
    )}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("mono font-bold text-base mt-0.5", active ? "text-primary" : "text-muted-foreground")}>
        {value}
      </div>
      <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>
    </div>
  );
}

function ActionCard({ action }: { action: RLAction | null }) {
  const cfg = {
    LONG:  { color: "text-bull", border: "border-bull/30 bg-bull/5",  Icon: TrendingUp,   ar: "شراء" },
    SHORT: { color: "text-bear", border: "border-bear/30 bg-bear/5",  Icon: TrendingDown,  ar: "بيع"  },
    HOLD:  { color: "text-gold", border: "border-gold/30 bg-gold/5",  Icon: Minus,         ar: "انتظار" },
  };
  const c = action ? cfg[action] : null;
  return (
    <div className={cn(
      "rounded-xl border p-3 transition-colors",
      c ? c.border : "border-border bg-card/40"
    )}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">آخر قرار</div>
      {c ? (
        <>
          <div className={cn("flex items-center gap-1.5 mt-0.5", c.color)}>
            <c.Icon className="size-4" />
            <span className="mono font-bold text-base">{action}</span>
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">{c.ar}</div>
        </>
      ) : (
        <div className="mono font-bold text-base text-muted-foreground mt-0.5">—</div>
      )}
    </div>
  );
}

function ConfidenceCard({ confidence }: { confidence: number | null }) {
  const color =
    confidence === null ? "text-muted-foreground"
    : confidence >= 75 ? "text-bull"
    : confidence >= 55 ? "text-gold"
    : "text-bear";
  return (
    <div className="rounded-xl border border-border bg-card/40 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">ثقة القرار</div>
      <div className={cn("mono font-bold text-base mt-0.5", color)}>
        {confidence !== null ? `${confidence}%` : "—"}
      </div>
      {confidence !== null && (
        <div className="mt-1.5 h-1.5 rounded-full bg-secondary overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all",
              confidence >= 75 ? "bg-bull" : confidence >= 55 ? "bg-gold" : "bg-bear"
            )}
            style={{ width: `${confidence}%` }}
          />
        </div>
      )}
    </div>
  );
}

function StateFeature({ name, value }: { name: string; value: number }) {
  const color = value > 0.05 ? "text-bull" : value < -0.05 ? "text-bear" : "text-muted-foreground";
  const shortName: Record<string, string> = {
    score: "Score", confidence: "Conf", bookImbalance: "Imbal",
    proximityPressure: "WallPx", microDrift: "Micro", momentum: "Mom",
    volumeTrend: "VolDir", rsiPenalty: "RSI", spreadPct: "Sprd", wallImbalance: "WallImb",
  };
  return (
    <div className="rounded-lg border border-border bg-card/40 px-2 py-1.5 text-center">
      <div className="text-[9px] text-muted-foreground uppercase tracking-wider">{shortName[name] ?? name}</div>
      <div className={cn("mono text-[11px] font-bold", color)}>
        {value >= 0 ? "+" : ""}{value.toFixed(3)}
      </div>
    </div>
  );
}

function LogRow({ decision, isCurrent }: { decision: AgentDecision; isCurrent: boolean }) {
  const time = new Date(decision.timestamp).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const color = {
    LONG: "text-bull", SHORT: "text-bear", HOLD: "text-gold",
  }[decision.action];
  return (
    <div className={cn(
      "flex items-center justify-between px-2.5 py-1.5 rounded-lg text-[11px] mono",
      isCurrent ? "bg-primary/8 border border-primary/20" : "bg-card/30 border border-border/50"
    )}>
      <span className="text-muted-foreground">{time}</span>
      <span className={cn("font-bold", color)}>{decision.action}</span>
      <span className="text-muted-foreground">ثقة {decision.confidence}%</span>
      <span className="text-muted-foreground">{fmtPrice(decision.entry)}</span>
    </div>
  );
}
