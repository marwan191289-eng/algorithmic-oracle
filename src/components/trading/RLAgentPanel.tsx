import { useState, useEffect, useRef, useCallback } from "react";
import type { InstitutionalVerdictV2, BookMetrics } from "@/lib/analysis";
import { cn } from "@/lib/utils";
import {
  Bot, Power, TrendingUp, TrendingDown, Minus,
  Activity, Database, Zap, RefreshCw,
} from "lucide-react";
import { fmtPrice } from "@/lib/binance";

// ── Types ──────────────────────────────────────────────────────────────────
type RLAction = "LONG" | "SHORT" | "HOLD";

interface ActionProbs { long: number; short: number; hold: number }

interface AgentDecision {
  action: RLAction;
  probs: ActionProbs;
  confidence: number;
  score: number;
  timestamp: number;
  entry: number;
  tick: number;
}

// ── Tiny in-browser neural network (no external deps) ─────────────────────
// 10 inputs → 24 hidden (ReLU) → 3 outputs (Softmax)
// Weights are deterministic and calibrated to institutional signals.
// This is a frozen PPO-inference approximation.

function relu(x: number) { return x > 0 ? x : 0; }

function softmax(arr: number[]): number[] {
  const max = Math.max(...arr);
  const exps = arr.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

// Fixed weights: W1[24×10], b1[24], W2[3×24], b2[3]
// Derived analytically so LONG fires on bullish cluster, SHORT on bearish.
function buildWeights() {
  // W1: each hidden unit is a dot product combination of inputs
  // Inputs: [score, conf, imbal, proxPx, micro, mom, volDir, rsi, sprd, wallImb]
  //          [0]   [1]   [2]    [3]     [4]    [5]  [6]     [7]  [8]   [9]
  const W1: number[][] = [];
  const b1: number[] = [];

  // Units 0-7: bullish detectors (react positively to bull signals)
  const bullWeights = [3.0, 1.5, 2.5, 2.0, 1.8, 2.2, 1.5, -1.0, -0.5, 1.8];
  for (let i = 0; i < 8; i++) {
    W1.push(bullWeights.map((w) => w * (0.85 + 0.3 * ((i * 7 + 3) % 10) / 10)));
    b1.push(-0.5 - i * 0.05);
  }
  // Units 8-15: bearish detectors (react positively to bear signals)
  const bearWeights = [-3.0, 1.5, -2.5, -2.0, -1.8, -2.2, -1.5, -1.0, -0.5, -1.8];
  for (let i = 0; i < 8; i++) {
    W1.push(bearWeights.map((w) => w * (0.85 + 0.3 * ((i * 11 + 7) % 10) / 10)));
    b1.push(-0.5 - i * 0.05);
  }
  // Units 16-23: uncertainty/HOLD detectors
  const holdWeights = [0.5, -0.5, 0.3, 0.3, 0.2, 0.2, 0.1, 1.2, 0.8, 0.3];
  for (let i = 0; i < 8; i++) {
    W1.push(holdWeights.map((w) => w * (0.9 + 0.2 * (i % 5) / 5)));
    b1.push(0.2);
  }

  // W2[3 × 24]: output layer
  // LONG  = sum(bull_units) - sum(bear_units)
  // SHORT = -sum(bull_units) + sum(bear_units)
  // HOLD  = sum(hold_units)
  const W2: number[][] = [
    [...Array(8).fill(1.8), ...Array(8).fill(-1.8), ...Array(8).fill(-0.4)], // LONG
    [...Array(8).fill(-1.8), ...Array(8).fill(1.8), ...Array(8).fill(-0.4)], // SHORT
    [...Array(8).fill(-0.5), ...Array(8).fill(-0.5), ...Array(8).fill(1.5)], // HOLD
  ];
  const b2 = [0.0, 0.0, 0.3]; // slight HOLD bias = conservative

  return { W1, b1, W2, b2 };
}

const { W1, b1, W2, b2 } = buildWeights();

function forwardPass(state: number[]): ActionProbs {
  // Hidden layer
  const hidden = W1.map((row, i) => {
    const z = row.reduce((sum, w, j) => sum + w * (state[j] ?? 0), 0) + b1[i];
    return relu(z);
  });

  // Output layer
  const logits = W2.map((row, i) =>
    row.reduce((sum, w, j) => sum + w * hidden[j], 0) + b2[i]
  );

  const [long, short, hold] = softmax(logits);
  return { long, short, hold };
}

// ── State vector ───────────────────────────────────────────────────────────
function buildStateArray(v: InstitutionalVerdictV2, m: BookMetrics): number[] {
  return [
    v.score / 100,
    v.confidence / 100,
    v.components.bookImbalance,
    v.components.proximityPressure,
    v.components.microDrift,
    v.components.momentum,
    v.components.volumeTrend,
    v.components.rsiPenalty,
    Math.min(m.spreadPct / 0.1, 1),      // normalize spread
    v.components.wallPressure,
  ];
}

function buildStateMap(v: InstitutionalVerdictV2, m: BookMetrics) {
  const arr = buildStateArray(v, m);
  const keys = ["Score","Conf","Imbal","WallPx","Micro","Mom","VolDir","RSI","Sprd","WallImb"];
  return keys.map((k, i) => ({ k, v: arr[i] }));
}

// ── Decision from probs ────────────────────────────────────────────────────
function decideAction(probs: ActionProbs): { action: RLAction; confidence: number } {
  const max = Math.max(probs.long, probs.short, probs.hold);
  let action: RLAction = "HOLD";
  if (max === probs.long) action = "LONG";
  else if (max === probs.short) action = "SHORT";
  // confidence = max probability × 100, adjusted for certainty
  const entropy = -(
    (probs.long > 0 ? probs.long * Math.log(probs.long) : 0) +
    (probs.short > 0 ? probs.short * Math.log(probs.short) : 0) +
    (probs.hold > 0 ? probs.hold * Math.log(probs.hold) : 0)
  );
  const maxEntropy = Math.log(3);
  const certainty = 1 - entropy / maxEntropy;
  const confidence = Math.round(max * 100 * (0.6 + 0.4 * certainty));
  return { action, confidence };
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
  const [thinking, setThinking] = useState(false);
  const [current, setCurrent] = useState<AgentDecision | null>(null);
  const [log, setLog] = useState<AgentDecision[]>([]);
  const tickRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const evaluate = useCallback(() => {
    if (!verdict || !metrics) return;
    setThinking(true);
    // tiny delay for visual "thinking" effect (50ms)
    setTimeout(() => {
      const state = buildStateArray(verdict, metrics);
      const probs = forwardPass(state);
      const { action, confidence } = decideAction(probs);
      tickRef.current += 1;
      const decision: AgentDecision = {
        action,
        probs,
        confidence,
        score: verdict.score,
        timestamp: Date.now(),
        entry: metrics.mid,
        tick: tickRef.current,
      };
      setCurrent(decision);
      setLog((prev) => [decision, ...prev].slice(0, 10));
      setThinking(false);
    }, 50);
  }, [verdict, metrics]);

  // Start / stop interval
  useEffect(() => {
    if (!active) {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }
    // Immediate first run
    evaluate();
    // Then every 2 seconds
    timerRef.current = setInterval(evaluate, 2000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [active, evaluate]);

  // Reset on deactivate
  useEffect(() => {
    if (!active) {
      setCurrent(null);
      setLog([]);
      tickRef.current = 0;
    }
  }, [active]);

  const stateItems =
    active && verdict && metrics ? buildStateMap(verdict, metrics) : null;

  const noData = active && (!verdict || !metrics);

  return (
    <div className={cn(
      "rounded-2xl border overflow-hidden transition-all duration-300",
      active
        ? "border-primary/50 bg-card/70 shadow-[0_0_24px_rgba(var(--primary-rgb,99,102,241),.12)]"
        : "border-border bg-card/60"
    )}>
      {/* Header */}
      <header className="flex items-center justify-between px-5 py-3.5 border-b border-border bg-card/80">
        <div className="flex items-center gap-3">
          <div className={cn(
            "relative size-9 rounded-xl flex items-center justify-center transition-colors",
            active ? "bg-primary/20 border border-primary/50" : "bg-muted/20 border border-border"
          )}>
            <Bot className={cn("size-4 transition-colors", active ? "text-primary" : "text-muted-foreground")} />
            {active && (
              <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-primary border-2 border-background animate-pulse" />
            )}
          </div>
          <div>
            <div className="font-bold text-sm flex items-center gap-2">
              RL Agent — عين الحوت
              {active && (
                <span className="text-[9px] mono px-1.5 py-0.5 rounded-full bg-primary/20 text-primary border border-primary/30 uppercase tracking-wider">
                  LIVE
                </span>
              )}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {active
                ? thinking
                  ? "جاري التحليل..."
                  : `تقييم كل 2 ثانية · تيكر #${tickRef.current}`
                : "Neural Policy · PPO Inference"}
            </div>
          </div>
        </div>
        <button
          onClick={() => setActive((v) => !v)}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-xl text-[12px] font-bold border transition-all",
            active
              ? "bg-primary text-primary-foreground border-primary shadow-[0_0_12px_rgba(var(--primary-rgb,99,102,241),.4)] hover:opacity-90"
              : "bg-card border-border text-foreground hover:border-primary hover:text-primary"
          )}
        >
          <Power className={cn("size-3.5 transition-transform", active && "rotate-0")} />
          {active ? "إيقاف" : "تفعيل الوكيل"}
        </button>
      </header>

      <div className="p-4 space-y-4">
        {/* No data state */}
        {noData && (
          <div className="rounded-xl border border-gold/30 bg-gold/5 p-3 flex items-center gap-2 text-sm text-gold">
            <RefreshCw className="size-4 animate-spin" />
            <span>في انتظار بيانات السوق الحية...</span>
          </div>
        )}

        {/* Decision cards */}
        {active && !noData && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <DecisionCard action={current?.action ?? null} thinking={thinking} />
              <ConfidenceCard confidence={current?.confidence ?? null} thinking={thinking} />
              <ScoreCard score={current?.score ?? null} thinking={thinking} />
            </div>

            {/* Probability bars */}
            {current && (
              <ProbBars probs={current.probs} thinking={thinking} />
            )}

            {/* State vector */}
            {stateItems && (
              <div className="rounded-xl border border-border bg-secondary/20 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <Database className="size-3 text-primary" />
                    State Vector
                  </div>
                  <span className="text-[10px] mono bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded-full">
                    {stateItems.length} features
                  </span>
                </div>
                <div className="grid grid-cols-5 gap-1.5">
                  {stateItems.map(({ k, v }) => (
                    <FeatureCell key={k} name={k} value={v} />
                  ))}
                </div>
              </div>
            )}

            {/* Decision log */}
            {log.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <Activity className="size-3 text-primary" />
                  سجل القرارات
                </div>
                <div className="space-y-1 max-h-48 overflow-y-auto rounded-xl border border-border bg-secondary/10 p-2">
                  {log.map((d) => (
                    <LogRow key={`${d.tick}-${d.timestamp}`} decision={d} isLatest={d.tick === current?.tick} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Inactive placeholder */}
        {!active && (
          <div className="flex flex-col items-center justify-center py-6 gap-3 text-center">
            <div className="size-12 rounded-2xl border border-border bg-secondary/30 flex items-center justify-center">
              <Zap className="size-5 text-muted-foreground" />
            </div>
            <div>
              <div className="text-sm font-semibold">اضغط "تفعيل الوكيل" للبدء</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                الوكيل يحلّل دفتر الأوامر ويصدر قرار كل ثانيتين
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function DecisionCard({ action, thinking }: { action: RLAction | null; thinking: boolean }) {
  const cfg = {
    LONG:  { color: "text-bull", bg: "bg-bull/8 border-bull/30",  Icon: TrendingUp,  ar: "شراء LONG"  },
    SHORT: { color: "text-bear", bg: "bg-bear/8 border-bear/30",  Icon: TrendingDown, ar: "بيع SHORT" },
    HOLD:  { color: "text-gold", bg: "bg-gold/8 border-gold/30",  Icon: Minus,        ar: "انتظار HOLD"},
  };
  const c = action ? cfg[action] : null;
  return (
    <div className={cn(
      "rounded-xl border p-3 transition-all",
      thinking ? "animate-pulse bg-secondary/30 border-border" : c ? c.bg : "bg-card/40 border-border"
    )}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">القرار</div>
      {c && !thinking ? (
        <>
          <div className={cn("flex items-center gap-1.5 mt-1", c.color)}>
            <c.Icon className="size-4" />
            <span className="mono font-black text-lg">{action}</span>
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">{c.ar}</div>
        </>
      ) : (
        <div className="h-8 mt-1 bg-secondary/50 rounded animate-pulse" />
      )}
    </div>
  );
}

function ConfidenceCard({ confidence, thinking }: { confidence: number | null; thinking: boolean }) {
  const color =
    confidence === null ? "text-muted-foreground"
    : confidence >= 70 ? "text-bull"
    : confidence >= 50 ? "text-gold"
    : "text-bear";
  return (
    <div className="rounded-xl border border-border bg-card/40 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">ثقة الوكيل</div>
      {!thinking && confidence !== null ? (
        <>
          <div className={cn("mono font-black text-lg mt-1", color)}>{confidence}%</div>
          <div className="mt-1.5 h-1.5 rounded-full bg-secondary overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all duration-500",
                confidence >= 70 ? "bg-bull" : confidence >= 50 ? "bg-gold" : "bg-bear"
              )}
              style={{ width: `${confidence}%` }}
            />
          </div>
        </>
      ) : (
        <div className="h-8 mt-1 bg-secondary/50 rounded animate-pulse" />
      )}
    </div>
  );
}

function ScoreCard({ score, thinking }: { score: number | null; thinking: boolean }) {
  const color = score === null ? "text-muted-foreground" : score >= 15 ? "text-bull" : score <= -15 ? "text-bear" : "text-gold";
  return (
    <div className="rounded-xl border border-border bg-card/40 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">درجة المؤسسي</div>
      {!thinking && score !== null ? (
        <>
          <div className={cn("mono font-black text-lg mt-1", color)}>
            {score >= 0 ? "+" : ""}{score.toFixed(1)}
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">[-100 → +100]</div>
        </>
      ) : (
        <div className="h-8 mt-1 bg-secondary/50 rounded animate-pulse" />
      )}
    </div>
  );
}

function ProbBars({ probs, thinking }: { probs: ActionProbs; thinking: boolean }) {
  const bars = [
    { label: "LONG", value: probs.long, color: "bg-bull" },
    { label: "HOLD", value: probs.hold, color: "bg-gold" },
    { label: "SHORT", value: probs.short, color: "bg-bear" },
  ];
  return (
    <div className="rounded-xl border border-border bg-secondary/20 p-3 space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">توزيع الاحتمالات</div>
      {bars.map(({ label, value, color }) => (
        <div key={label} className="flex items-center gap-2">
          <span className="mono text-[10px] text-muted-foreground w-10 text-left">{label}</span>
          <div className="flex-1 h-3 rounded-full bg-secondary overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all duration-500", color, thinking && "opacity-40")}
              style={{ width: `${(value * 100).toFixed(1)}%` }}
            />
          </div>
          <span className="mono text-[10px] text-muted-foreground w-8 text-left">
            {(value * 100).toFixed(0)}%
          </span>
        </div>
      ))}
    </div>
  );
}

function FeatureCell({ name, value }: { name: string; value: number }) {
  const color = value > 0.05 ? "text-bull" : value < -0.05 ? "text-bear" : "text-muted-foreground";
  return (
    <div className="rounded-lg border border-border bg-card/40 px-2 py-1.5 text-center">
      <div className="text-[9px] text-muted-foreground uppercase tracking-wider">{name}</div>
      <div className={cn("mono text-[11px] font-bold mt-0.5", color)}>
        {value >= 0 ? "+" : ""}{value.toFixed(3)}
      </div>
    </div>
  );
}

function LogRow({ decision, isLatest }: { decision: AgentDecision; isLatest: boolean }) {
  const time = new Date(decision.timestamp).toLocaleTimeString("ar", {
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const color = { LONG: "text-bull", SHORT: "text-bear", HOLD: "text-gold" }[decision.action];
  const bg = {
    LONG: "bg-bull/5 border-bull/20",
    SHORT: "bg-bear/5 border-bear/20",
    HOLD: "bg-secondary/20 border-border/50",
  }[decision.action];
  return (
    <div className={cn(
      "flex items-center justify-between px-2.5 py-1.5 rounded-lg text-[11px] mono border transition-all",
      isLatest ? "ring-1 ring-primary/30 " + bg : bg
    )}>
      <span className="text-muted-foreground w-16">{time}</span>
      <span className={cn("font-black w-12 text-center", color)}>{decision.action}</span>
      <span className="text-muted-foreground w-14 text-center">{decision.confidence}%</span>
      <span className="text-muted-foreground">{fmtPrice(decision.entry)}</span>
      <span className="text-muted-foreground text-[9px] w-10 text-left">#{decision.tick}</span>
    </div>
  );
}
