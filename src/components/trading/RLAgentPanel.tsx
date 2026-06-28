import { useState, useEffect, useRef, useCallback } from "react";
import type { InstitutionalVerdictV2, BookMetrics } from "@/lib/analysis";
import { cn } from "@/lib/utils";
import {
  Bot, Power, TrendingUp, TrendingDown, Minus,
  Activity, Database, Zap, RefreshCw, Brain, Target,
  BarChart2,
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
  explorationBonus: boolean;
}

interface Experience {
  state: number[];
  action: number; // 0=LONG, 1=SHORT, 2=HOLD
  reward: number;
  nextState: number[];
}

// ── Constants ──────────────────────────────────────────────────────────────
const INPUT_DIM   = 14;
const H1_DIM      = 32;
const H2_DIM      = 16;
const OUTPUT_DIM  = 3;
const LR          = 0.004;
const GAMMA       = 0.92;
const ENTROPY_C   = 0.08;
const BATCH_SIZE  = 24;
const MAX_REPLAY  = 500;
const INIT_EXPL   = 0.15;
const MIN_EXPL    = 0.02;
const EXPL_DECAY  = 0.998;

// ── Math helpers ───────────────────────────────────────────────────────────
function relu(x: number) { return x > 0 ? x : 0; }
function reluGrad(x: number) { return x > 0 ? 1 : 0; }
function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function clampN1(x: number) { return Math.max(-1, Math.min(1, x)); }

function softmax(arr: number[]): number[] {
  const max = Math.max(...arr);
  const exps = arr.map(x => Math.exp(x - max));
  const sum  = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map(e => e / sum);
}

// ── Weights type ───────────────────────────────────────────────────────────
interface Weights {
  W1: number[][]; b1: number[];
  W2: number[][]; b2: number[];
  W3: number[][]; b3: number[];
}

// ── Analytically-initialised weights ──────────────────────────────────────
// Inputs: [score, conf, imbal, proxPx, micro, mom, volDir, rsi,
//          sprd,  wallImb, atrNorm, entropy, recentWR, momStr]
//          [0]    [1]    [2]    [3]    [4]    [5]    [6]    [7]
//          [8]    [9]    [10]   [11]   [12]   [13]
function buildInitialWeights(): Weights {
  const bull  = [ 3.2, 1.6, 2.8, 2.2, 1.9, 2.4, 1.6,-1.1,-0.5, 1.9, 0.3, 0.2, 1.2, 0.4];
  const bear  = [-3.2, 1.6,-2.8,-2.2,-1.9,-2.4,-1.6, 1.1,-0.5,-1.9, 0.3, 0.2,-1.2, 0.4];
  const hold  = [ 0.5,-0.5, 0.3, 0.3, 0.2, 0.2, 0.1, 1.3, 0.9, 0.3,-0.2, 0.8,-0.3, 0.5];
  const vol   = [ 0.2, 0.8, 0.1, 0.1, 0.5, 0.4, 0.6, 0.2, 1.2, 0.1,-1.8,-0.5, 0.4, 0.3];

  const W1: number[][] = [];
  const b1: number[]   = [];
  for (let i = 0; i < 10; i++) {
    W1.push(bull.map((w, j) => w * (0.80 + 0.35 * ((i * 7 + j * 3) % 10) / 10)));
    b1.push(-0.4 - i * 0.04);
  }
  for (let i = 0; i < 10; i++) {
    W1.push(bear.map((w, j) => w * (0.80 + 0.35 * ((i * 11 + j * 5) % 10) / 10)));
    b1.push(-0.4 - i * 0.04);
  }
  for (let i = 0; i < 8; i++) {
    W1.push(hold.map(w => w * (0.9 + 0.2 * (i % 5) / 5)));
    b1.push(0.2);
  }
  for (let i = 0; i < 4; i++) {
    W1.push(vol.map(w => w * (0.85 + 0.15 * i / 4)));
    b1.push(0.0);
  }

  const W2: number[][] = [];
  const b2: number[]   = [];
  for (let i = 0; i < H2_DIM; i++) {
    const row: number[] = [];
    for (let j = 0; j < H1_DIM; j++) {
      if (i < 6)       row.push(j < 10 ? 1.2 : j < 20 ? -1.0 : 0.0);
      else if (i < 12) row.push(j < 10 ? -1.0 : j < 20 ? 1.2 : 0.0);
      else             row.push(j < 20 ? -0.4 : 1.0);
    }
    W2.push(row.map(w => w * (0.3 + (i % 3) * 0.05)));
    b2.push(i < 6 ? 0.0 : i < 12 ? 0.0 : 0.2);
  }

  const W3: number[][] = [
    [...Array(6).fill(2.0), ...Array(6).fill(-1.8), ...Array(4).fill(-0.4)],
    [...Array(6).fill(-1.8),...Array(6).fill(2.0),  ...Array(4).fill(-0.4)],
    [...Array(6).fill(-0.5),...Array(6).fill(-0.5), ...Array(4).fill(1.6)],
  ];
  const b3 = [0.0, 0.0, 0.4];

  return { W1, b1, W2, b2, W3, b3 };
}

// ── Forward pass ───────────────────────────────────────────────────────────
interface FwdResult {
  h1pre: number[]; h1: number[];
  h2pre: number[]; h2: number[];
  logits: number[]; probs: number[];
}

function forward(state: number[], w: Weights): FwdResult {
  const h1pre = w.W1.map((row, i) =>
    row.reduce((s, wi, j) => s + wi * (state[j] ?? 0), 0) + w.b1[i]);
  const h1 = h1pre.map(relu);

  const h2pre = w.W2.map((row, i) =>
    row.reduce((s, wi, j) => s + wi * h1[j], 0) + w.b2[i]);
  const h2 = h2pre.map(relu);

  const logits = w.W3.map((row, i) =>
    row.reduce((s, wi, j) => s + wi * h2[j], 0) + w.b3[i]);
  const probs = softmax(logits);

  return { h1pre, h1, h2pre, h2, logits, probs };
}

// ── REINFORCE gradient update ──────────────────────────────────────────────
function updateWeights(w: Weights, batch: Experience[]): Weights {
  // Deep-clone weights
  const nW1 = w.W1.map(r => [...r]);
  const nb1 = [...w.b1];
  const nW2 = w.W2.map(r => [...r]);
  const nb2 = [...w.b2];
  const nW3 = w.W3.map(r => [...r]);
  const nb3 = [...w.b3];

  const clip = (v: number) => Math.max(-1.5, Math.min(1.5, v));

  for (const exp of batch) {
    const f    = forward(exp.state, w);
    const { h1, h1pre, h2, h2pre, probs } = f;

    // TD advantage
    const nextV   = GAMMA * Math.max(...forward(exp.nextState, w).probs);
    const adv     = Math.max(-2, Math.min(2, exp.reward + nextV - probs[exp.action]));

    // Entropy
    const entropy = -probs.reduce((s, p) => s + (p > 1e-9 ? p * Math.log(p) : 0), 0);

    // Output-layer gradient (policy grad + entropy bonus)
    const dLogits = probs.map((p, k) => {
      const pg = -adv * ((k === exp.action ? 1 : 0) - p);
      const eg = -ENTROPY_C * (-Math.log(p + 1e-8) - entropy);
      return pg + eg;
    });

    // W3, b3
    for (let k = 0; k < OUTPUT_DIM; k++) {
      for (let j = 0; j < H2_DIM; j++) nW3[k][j] = clip(nW3[k][j] - LR * dLogits[k] * h2[j]);
      nb3[k] = clip(nb3[k] - LR * dLogits[k]);
    }

    // δh2
    const dh2 = Array(H2_DIM).fill(0).map((_, j) =>
      w.W3.reduce((s, row, k) => s + row[j] * dLogits[k], 0) * reluGrad(h2pre[j])
    );

    // W2, b2
    for (let i = 0; i < H2_DIM; i++) {
      for (let j = 0; j < H1_DIM; j++) nW2[i][j] = clip(nW2[i][j] - LR * dh2[i] * h1[j]);
      nb2[i] = clip(nb2[i] - LR * dh2[i]);
    }

    // δh1
    const dh1 = Array(H1_DIM).fill(0).map((_, j) =>
      w.W2.reduce((s, row, i) => s + row[j] * dh2[i], 0) * reluGrad(h1pre[j])
    );

    // W1, b1
    for (let i = 0; i < H1_DIM; i++) {
      for (let j = 0; j < INPUT_DIM; j++) nW1[i][j] = clip(nW1[i][j] - LR * dh1[i] * (exp.state[j] ?? 0));
      nb1[i] = clip(nb1[i] - LR * dh1[i]);
    }
  }

  return { W1: nW1, b1: nb1, W2: nW2, b2: nb2, W3: nW3, b3: nb3 };
}

// ── State vector (14 features) ─────────────────────────────────────────────
function buildState(
  v: InstitutionalVerdictV2 | null,
  m: BookMetrics,
  recentWR: number,
  recentProbs: ActionProbs | null
): number[] {
  // Feature 11: entropy of last decision (high=uncertain, low=confident)
  const entropy = recentProbs
    ? -([recentProbs.long, recentProbs.short, recentProbs.hold]
        .reduce((s, p) => s + (p > 1e-9 ? p * Math.log(p) : 0), 0))
    : Math.log(3);
  const normEntropy = clamp01(entropy / Math.log(3));

  // Feature 10: ATR proxy from spread
  const atrProxy = clamp01(m.spreadPct / 0.05);

  // Feature 8: spread normalised (raw spreadPct / 0.1 → typical BTC spread ~0.002%)
  const spread = clamp01(m.spreadPct / 0.1);

  if (v) {
    return [
      clampN1(v.score / 100),                                   // 0 score
      clamp01(v.confidence / 100),                              // 1 confidence
      clampN1(v.components.bookImbalance),                      // 2 bookImbalance
      clampN1(v.components.proximityPressure),                  // 3 proximityPressure
      clampN1(v.components.microDrift),                         // 4 microDrift
      clampN1(v.components.momentum),                           // 5 momentum
      clampN1(v.components.volumeTrend),                        // 6 volumeTrend
      clamp01((v.components.rsiPenalty + 0.4) / 0.8),           // 7 rsiPenalty → [0,1]
      spread,                                                    // 8 spread
      clampN1(v.components.wallPressure),                       // 9 wallPressure
      atrProxy,                                                  // 10 ATR proxy
      normEntropy,                                               // 11 entropy
      clamp01(recentWR),                                         // 12 recent win rate
      clamp01(Math.abs(v.components.momentum)),                  // 13 momentum strength
    ];
  }

  // Partial state (no verdict yet — book-only)
  const microDrift = m.mid > 0
    ? clampN1((m.microPrice - m.mid) / Math.max(m.spread, m.mid * 1e-6) * 2)
    : 0;
  const vwapPressure = m.mid > 0
    ? clampN1((m.vwapBid - m.vwapAsk) / m.mid)
    : 0;

  return [
    0,                           // 0  score unknown
    0,                           // 1  confidence unknown
    clampN1(m.imbalance),        // 2  bookImbalance
    vwapPressure,                // 3  proximityPressure proxy
    microDrift,                  // 4  microDrift
    0,                           // 5  momentum unknown
    0,                           // 6  volumeTrend unknown
    0.5,                         // 7  rsiPenalty neutral
    spread,                      // 8  spread
    clampN1(m.imbalance * 0.5),  // 9  wallPressure proxy
    atrProxy,                    // 10 ATR proxy
    normEntropy,                 // 11 entropy
    clamp01(recentWR),           // 12 recent win rate
    0,                           // 13 momentum strength unknown
  ];
}

// ── Decision from forward-pass probs ──────────────────────────────────────
function decide(
  probs: number[],
  explorationRate: number
): { action: RLAction; confidence: number; explored: boolean } {
  const [pLong, pShort, pHold] = probs;
  let action: RLAction;
  let explored = false;

  if (Math.random() < explorationRate) {
    // Sample from distribution (softmax exploration)
    const r = Math.random();
    action = r < pLong ? "LONG" : r < pLong + pShort ? "SHORT" : "HOLD";
    explored = true;
  } else {
    const max = Math.max(pLong, pShort, pHold);
    action = max === pLong ? "LONG" : max === pShort ? "SHORT" : "HOLD";
  }

  const pAct = action === "LONG" ? pLong : action === "SHORT" ? pShort : pHold;
  const ent  = -([pLong, pShort, pHold].reduce((s, p) => s + (p > 1e-9 ? p * Math.log(p) : 0), 0));
  const certainty = 1 - ent / Math.log(3);
  const confidence = Math.round(pAct * 100 * (0.6 + 0.4 * certainty));

  return { action, confidence, explored };
}

// ── Component ──────────────────────────────────────────────────────────────
export function RLAgentPanel({
  verdict,
  metrics,
}: {
  verdict: InstitutionalVerdictV2 | null;
  metrics: BookMetrics | null;
}) {
  // ── display state ────────────────────────────────────────────────────────
  const [active,       setActive]       = useState(false);
  const [thinking,     setThinking]     = useState(false);
  const [current,      setCurrent]      = useState<AgentDecision | null>(null);
  const [log,          setLog]          = useState<AgentDecision[]>([]);
  const [dispExpl,     setDispExpl]     = useState(INIT_EXPL);      // display only
  const [dispStep,     setDispStep]     = useState(0);              // display only
  const [dispWR,       setDispWR]       = useState(0);              // display only
  const [dispTrades,   setDispTrades]   = useState(0);              // display only

  // ── mutable refs (no re-render side-effects) ──────────────────────────
  const weightsRef   = useRef<Weights>(buildInitialWeights());
  const replayRef    = useRef<Experience[]>([]);
  const tickRef      = useRef(0);
  const stepRef      = useRef(0);         // learning steps
  const winRef       = useRef(0);         // wins
  const tradeRef     = useRef(0);         // total trades evaluated
  const explRef      = useRef(INIT_EXPL); // live exploration rate
  const lastRef      = useRef<{ state: number[]; action: number; price: number } | null>(null);
  const probsRef     = useRef<ActionProbs | null>(null);          // last probs for state
  const timerRef     = useRef<ReturnType<typeof setInterval> | null>(null);

  // Sync props → refs so evaluate() always reads current values
  const verdictRef = useRef(verdict);
  const metricsRef = useRef(metrics);
  useEffect(() => { verdictRef.current  = verdict;  }, [verdict]);
  useEffect(() => { metricsRef.current  = metrics;  }, [metrics]);

  // ── core evaluation (no deps → stable identity throughout lifecycle) ──
  const evaluate = useCallback(() => {
    const m = metricsRef.current;
    const v = verdictRef.current;
    if (!m) return;

    setThinking(true);

    // Use setTimeout so we don't block the websocket event loop
    setTimeout(() => {
      const wr = tradeRef.current > 0 ? winRef.current / tradeRef.current : 0.5;

      // ── 1. compute reward from previous decision ────────────────────
      if (lastRef.current && m.mid) {
        const prev    = lastRef.current;
        const delta   = (m.mid - prev.price) / prev.price;
        let reward = 0;
        if      (prev.action === 0) reward =  delta * 10;        // LONG
        else if (prev.action === 1) reward = -delta * 10;        // SHORT
        else                        reward = Math.max(0, 0.05 - Math.abs(delta) * 5); // HOLD

        const newState = buildState(v, m, wr, probsRef.current);
        replayRef.current = [
          { state: prev.state, action: prev.action, reward, nextState: newState },
          ...replayRef.current,
        ].slice(0, MAX_REPLAY);

        // mini-batch gradient update
        if (replayRef.current.length >= BATCH_SIZE) {
          const shuffled = [...replayRef.current].sort(() => Math.random() - 0.5);
          weightsRef.current = updateWeights(weightsRef.current, shuffled.slice(0, BATCH_SIZE));
          stepRef.current += 1;

          const isWin = reward > 0.01;
          if (isWin) winRef.current++;
          tradeRef.current++;

          // Anneal exploration
          explRef.current = Math.max(MIN_EXPL, explRef.current * EXPL_DECAY);

          // Update display state (batched, low-frequency)
          if (stepRef.current % 5 === 0) {
            setDispStep(stepRef.current);
            setDispExpl(explRef.current);
            setDispWR(tradeRef.current > 0 ? winRef.current / tradeRef.current : 0);
            setDispTrades(tradeRef.current);
          }
        }
      }

      // ── 2. forward pass with current weights ───────────────────────
      const state  = buildState(v, m, wr, probsRef.current);
      const result = forward(state, weightsRef.current);
      const probs: ActionProbs = { long: result.probs[0], short: result.probs[1], hold: result.probs[2] };
      const { action, confidence, explored } = decide(result.probs, explRef.current);

      // Store for next reward computation
      probsRef.current = probs;
      lastRef.current  = { state, action: action === "LONG" ? 0 : action === "SHORT" ? 1 : 2, price: m.mid };

      tickRef.current += 1;
      const decision: AgentDecision = {
        action, probs, confidence,
        score:     v?.score ?? 0,
        timestamp: Date.now(),
        entry:     m.mid,
        tick:      tickRef.current,
        explorationBonus: explored,
      };

      setCurrent(decision);
      setLog(prev => [decision, ...prev].slice(0, 15));
      setThinking(false);
    }, 50);
  }, []); // ← empty deps: evaluate is stable, reads props via refs

  // ── interval management ───────────────────────────────────────────────
  useEffect(() => {
    if (!active) {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      return;
    }
    evaluate();
    timerRef.current = setInterval(evaluate, 2000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [active, evaluate]);

  // ── reset on deactivate ───────────────────────────────────────────────
  useEffect(() => {
    if (!active) {
      setCurrent(null); setLog([]);
      tickRef.current = 0; stepRef.current = 0;
      winRef.current = 0; tradeRef.current = 0;
      explRef.current = INIT_EXPL;
      lastRef.current = null; probsRef.current = null;
      weightsRef.current = buildInitialWeights();
      replayRef.current  = [];
      setDispStep(0); setDispExpl(INIT_EXPL); setDispWR(0); setDispTrades(0);
    }
  }, [active]);

  const stateForDisplay = active && metrics
    ? buildState(verdictRef.current, metrics, dispWR, probsRef.current)
    : null;
  const featureKeys = ["Score","Conf","Imbal","WallPx","Micro","Mom","VolDir","RSI","Sprd","WallImb","ATR","Entr","WinR","MomStr"];

  const noData = active && !metrics;

  return (
    <div className={cn(
      "rounded-2xl border overflow-hidden transition-all duration-300",
      active
        ? "border-primary/50 bg-card/70 shadow-[0_0_24px_rgba(var(--primary-rgb,99,102,241),.15)]"
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
                <>
                  <span className="text-[9px] mono px-1.5 py-0.5 rounded-full bg-primary/20 text-primary border border-primary/30 uppercase tracking-wider">LIVE</span>
                  {dispStep > 0 && (
                    <span className="text-[9px] mono px-1.5 py-0.5 rounded-full bg-bull/20 text-bull border border-bull/30 uppercase tracking-wider flex items-center gap-0.5">
                      <Brain className="size-2.5" /> Learning
                    </span>
                  )}
                </>
              )}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {active
                ? thinking
                  ? "جاري التحليل..."
                  : `تيكر #${tickRef.current} · خطوات: ${dispStep} · ε=${(dispExpl * 100).toFixed(0)}%`
                : "REINFORCE · 14 features · 32-16-3 · Online Learning"
              }
            </div>
          </div>
        </div>
        <button
          onClick={() => setActive(v => !v)}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-xl text-[12px] font-bold border transition-all",
            active
              ? "bg-primary text-primary-foreground border-primary shadow-[0_0_12px_rgba(var(--primary-rgb,99,102,241),.4)] hover:opacity-90"
              : "bg-card border-border text-foreground hover:border-primary hover:text-primary"
          )}
        >
          <Power className="size-3.5" />
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

        {/* Active content */}
        {active && !noData && (
          <>
            {/* Main decision cards */}
            <div className="grid grid-cols-3 gap-3">
              <DecisionCard action={current?.action ?? null} thinking={thinking} explored={current?.explorationBonus} />
              <ConfidenceCard confidence={current?.confidence ?? null} thinking={thinking} />
              <ScoreCard score={current?.score ?? null} thinking={thinking} />
            </div>

            {/* Probability bars */}
            {current && <ProbBars probs={current.probs} thinking={thinking} />}

            {/* Performance strip */}
            {dispTrades >= 2 && (
              <div className="rounded-xl border border-border bg-secondary/20 p-3 grid grid-cols-4 gap-2 text-center">
                <MiniStat label="الصفقات" value={String(dispTrades)} />
                <MiniStat label="WinRate"
                  value={`${(dispWR * 100).toFixed(0)}%`}
                  color={dispWR >= 0.55 ? "text-bull" : dispWR >= 0.45 ? "text-gold" : "text-bear"} />
                <MiniStat label="خطوات التعلم" value={String(dispStep)} color="text-primary" />
                <MiniStat label="استكشاف"
                  value={`${(dispExpl * 100).toFixed(1)}%`}
                  color={dispExpl < 0.05 ? "text-bull" : "text-muted-foreground"} />
              </div>
            )}

            {/* State vector */}
            {stateForDisplay && (
              <div className="rounded-xl border border-border bg-secondary/20 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <Database className="size-3 text-primary" />
                    State Vector
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] mono text-gold">ε={( dispExpl * 100).toFixed(1)}%</span>
                    <span className="text-[10px] mono bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded-full">
                      {INPUT_DIM} features
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {featureKeys.map((k, i) => (
                    <FeatureCell key={k} name={k} value={stateForDisplay[i] ?? 0} />
                  ))}
                </div>
                {dispStep > 0 && (
                  <div className="flex items-center gap-1.5 text-[10px] text-bull mt-1">
                    <Brain className="size-3" />
                    <span>خطوات تدريب: {dispStep} · ذاكرة: {replayRef.current.length}/{MAX_REPLAY}</span>
                  </div>
                )}
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
                  {log.map(d => (
                    <LogRow
                      key={`${d.tick}-${d.timestamp}`}
                      decision={d}
                      isLatest={d.tick === current?.tick}
                    />
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
              <div className="text-[11px] text-muted-foreground mt-0.5 max-w-xs mx-auto">
                وكيل تعزيزي حقيقي (REINFORCE) بذاكرة تجارب وتعلم تلقائي متواصل
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-2 text-[10px]">
              <ArchBadge icon={<Brain className="size-3" />} label="14 مدخل" />
              <ArchBadge icon={<BarChart2 className="size-3" />} label="32-16-3 طبقات" />
              <ArchBadge icon={<Target className="size-3" />} label="REINFORCE" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────
function ArchBadge({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="rounded-lg border border-border bg-card/40 px-2 py-1.5 flex items-center gap-1.5 justify-center text-muted-foreground">
      {icon} {label}
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card/40 py-1.5">
      <div className="text-[9px] text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className={cn("mono text-[11px] font-bold mt-0.5", color ?? "text-foreground")}>{value}</div>
    </div>
  );
}

function DecisionCard({
  action, thinking, explored,
}: { action: RLAction | null; thinking: boolean; explored?: boolean }) {
  const cfg = {
    LONG:  { color: "text-bull", bg: "bg-bull/8 border-bull/30",  Icon: TrendingUp,   ar: "شراء LONG"  },
    SHORT: { color: "text-bear", bg: "bg-bear/8 border-bear/30",  Icon: TrendingDown, ar: "بيع SHORT"  },
    HOLD:  { color: "text-gold", bg: "bg-gold/8 border-gold/30",  Icon: Minus,        ar: "انتظار HOLD"},
  };
  const c = action ? cfg[action] : null;
  return (
    <div className={cn(
      "rounded-xl border p-3 transition-all relative",
      thinking ? "animate-pulse bg-secondary/30 border-border" : c ? c.bg : "bg-card/40 border-border"
    )}>
      {explored && !thinking && (
        <span className="absolute top-1 left-1 text-[8px] mono text-primary opacity-60">ε</span>
      )}
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
    : confidence >= 70  ? "text-bull"
    : confidence >= 50  ? "text-gold"
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
  const color = score === null ? "text-muted-foreground"
    : score >= 15 ? "text-bull" : score <= -15 ? "text-bear" : "text-gold";
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
    { label: "LONG",  value: probs.long,  color: "bg-bull" },
    { label: "HOLD",  value: probs.hold,  color: "bg-gold" },
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
    <div className="rounded-lg border border-border bg-card/40 px-1.5 py-1 text-center">
      <div className="text-[8px] text-muted-foreground uppercase tracking-wider truncate">{name}</div>
      <div className={cn("mono text-[10px] font-bold mt-0.5", color)}>
        {value >= 0 ? "+" : ""}{value.toFixed(2)}
      </div>
    </div>
  );
}

function LogRow({ decision, isLatest }: { decision: AgentDecision; isLatest: boolean }) {
  const time  = new Date(decision.timestamp).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const color = { LONG: "text-bull", SHORT: "text-bear", HOLD: "text-gold" }[decision.action];
  const bg    = {
    LONG:  "bg-bull/5 border-bull/20",
    SHORT: "bg-bear/5 border-bear/20",
    HOLD:  "bg-secondary/20 border-border/50",
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
      {decision.explorationBonus && <span className="text-[8px] text-primary w-3">ε</span>}
      <span className="text-muted-foreground text-[9px] w-10 text-left">#{decision.tick}</span>
    </div>
  );
}
