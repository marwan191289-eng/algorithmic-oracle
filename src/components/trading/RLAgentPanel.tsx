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
  explored: boolean;
}

interface PendingReward {
  state: number[];
  action: number;
  entry: number;   // price when decision was made
  tick: number;
  evalAtTick: number; // evaluate reward when tick reaches this
}

interface Experience {
  state: number[];
  action: number;
  reward: number;
  nextState: number[];
}

// ── Constants ──────────────────────────────────────────────────────────────
const IN   = 14;
const H1   = 32;
const H2   = 16;
const OUT  = 3;
const LR          = 0.004;
const ENTROPY_C   = 0.08;
const BATCH       = 24;
const REPLAY_MAX  = 800;
const REWARD_TICKS= 5;     // evaluate reward after 5 ticks (~10s)
const INIT_EXPL   = 0.22;
const MIN_EXPL    = 0.04;
const EXPL_DECAY  = 0.9985; // slower decay → more exploration

// ── Math ───────────────────────────────────────────────────────────────────
const relu = (x: number) => (x > 0 ? x : 0);
const rgrad = (x: number) => (x > 0 ? 1 : 0);
const c01   = (x: number) => Math.max(0, Math.min(1, x));
const cN1   = (x: number) => Math.max(-1, Math.min(1, x));

function softmax(a: number[]): number[] {
  const m = Math.max(...a);
  const e = a.map(x => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0) || 1;
  return e.map(v => v / s);
}

// ── Weights ─────────────────────────────────────────────────────────────────
interface W { W1:number[][];b1:number[];W2:number[][];b2:number[];W3:number[][];b3:number[] }

// Xavier / Glorot uniform initialisation with tiny domain-knowledge bias
// Features: [score, conf, imbal, wallPx, micro, mom, volDir, rsi,
//            sprd,  wallImb, atrNorm, entropy, recentWR, momStr]
//            [0]    [1]    [2]    [3]     [4]    [5]    [6]    [7]
//            [8]    [9]    [10]   [11]    [12]   [13]
function initWeights(): W {
  const r1 = Math.sqrt(6 / (IN + H1));  // ≈ 0.361
  const r2 = Math.sqrt(6 / (H1 + H2)); // ≈ 0.354
  const r3 = Math.sqrt(6 / (H2 + OUT)); // ≈ 0.562
  const rng = (r: number) => (Math.random() * 2 - 1) * r;

  // Domain bias magnitudes (tiny — won't saturate softmax)
  const BULL: Record<number, number> = { 0:0.06, 2:0.05, 5:0.05, 9:0.04, 12:0.04, 13:0.04 };
  const BEAR: Record<number, number> = { 0:-0.06, 2:-0.05, 5:-0.05, 9:-0.04, 12:-0.04, 13:-0.04 };
  const HOLD: Record<number, number> = { 7:0.05, 8:0.06, 10:0.04, 11:0.06 };

  const W1: number[][] = [];
  const b1: number[] = [];
  for (let i = 0; i < H1; i++) {
    const row = Array.from({ length: IN }, () => rng(r1));
    const bias = i < 11 ? BULL : i < 22 ? BEAR : HOLD;
    for (const [j, d] of Object.entries(bias)) row[+j] += d;
    W1.push(row);
    b1.push(0);
  }

  const W2 = Array.from({ length: H2 }, () => Array.from({ length: H1 }, () => rng(r2)));
  const b2 = Array(H2).fill(0);

  const W3 = Array.from({ length: OUT }, () => Array.from({ length: H2 }, () => rng(r3)));
  const b3 = [0.0, 0.0, 0.15]; // slight initial HOLD preference

  return { W1, b1, W2, b2, W3, b3 };
}

// ── Forward pass ────────────────────────────────────────────────────────────
interface FWD { h1p:number[];h1:number[];h2p:number[];h2:number[];logits:number[];probs:number[] }
function fwd(s: number[], w: W): FWD {
  const h1p = w.W1.map((row, i) => row.reduce((a, wi, j) => a + wi * (s[j] ?? 0), 0) + w.b1[i]);
  const h1  = h1p.map(relu);
  const h2p = w.W2.map((row, i) => row.reduce((a, wi, j) => a + wi * h1[j], 0) + w.b2[i]);
  const h2  = h2p.map(relu);
  const lg  = w.W3.map((row, i) => row.reduce((a, wi, j) => a + wi * h2[j], 0) + w.b3[i]);
  return { h1p, h1, h2p, h2, logits: lg, probs: softmax(lg) };
}

// ── REINFORCE update ────────────────────────────────────────────────────────
// Advantage is batch-normalised (reward - mean) / std — stable regardless of
// reward scale. Gradient clip widened to ±2.0 to allow faster learning.
function update(w: W, batch: Experience[]): W {
  const nW1 = w.W1.map(r => [...r]), nb1 = [...w.b1];
  const nW2 = w.W2.map(r => [...r]), nb2 = [...w.b2];
  const nW3 = w.W3.map(r => [...r]), nb3 = [...w.b3];
  const clipG = (v: number) => Math.max(-2.0, Math.min(2.0, v)); // gradient clip
  const clipW = (v: number) => Math.max(-3.0, Math.min(3.0, v)); // weight clip

  // Batch-normalise rewards → stable advantage regardless of scale
  const rewards = batch.map(e => e.reward);
  const meanR = rewards.reduce((s, r) => s + r, 0) / rewards.length;
  const varR  = rewards.reduce((s, r) => s + (r - meanR) ** 2, 0) / rewards.length;
  const stdR  = Math.sqrt(varR) || 1;

  for (const ex of batch) {
    const f = fwd(ex.state, w);
    const { h1, h1p, h2, h2p, probs } = f;

    // Normalised advantage + entropy regularisation
    const adv = Math.max(-3, Math.min(3, (ex.reward - meanR) / stdR));
    const ent = -probs.reduce((s, p) => s + (p > 1e-9 ? p * Math.log(p) : 0), 0);
    const dLogits = probs.map((p, k) => {
      const pg = -adv * ((k === ex.action ? 1 : 0) - p);
      const eg = -ENTROPY_C * (-Math.log(p + 1e-8) - ent);
      return pg + eg;
    });

    for (let k = 0; k < OUT; k++) {
      for (let j = 0; j < H2; j++) nW3[k][j] = clipW(nW3[k][j] - clipG(LR * dLogits[k] * h2[j]));
      nb3[k] = clipW(nb3[k] - clipG(LR * dLogits[k]));
    }
    const dh2 = Array(H2).fill(0).map((_, j) =>
      w.W3.reduce((s, row, k) => s + row[j] * dLogits[k], 0) * rgrad(h2p[j]));
    for (let i = 0; i < H2; i++) {
      for (let j = 0; j < H1; j++) nW2[i][j] = clipW(nW2[i][j] - clipG(LR * dh2[i] * h1[j]));
      nb2[i] = clipW(nb2[i] - clipG(LR * dh2[i]));
    }
    const dh1 = Array(H1).fill(0).map((_, j) =>
      w.W2.reduce((s, row, i) => s + row[j] * dh2[i], 0) * rgrad(h1p[j]));
    for (let i = 0; i < H1; i++) {
      for (let j = 0; j < IN; j++) nW1[i][j] = clipW(nW1[i][j] - clipG(LR * dh1[i] * (ex.state[j] ?? 0)));
      nb1[i] = clipW(nb1[i] - clipG(LR * dh1[i]));
    }
  }
  return { W1: nW1, b1: nb1, W2: nW2, b2: nb2, W3: nW3, b3: nb3 };
}

// ── State vector ────────────────────────────────────────────────────────────
function buildState(
  v: InstitutionalVerdictV2 | null,
  m: BookMetrics,
  recentWR: number,
  lastProbs: ActionProbs | null
): number[] {
  const ent    = lastProbs
    ? -([lastProbs.long, lastProbs.short, lastProbs.hold].reduce((s, p) => s + (p > 1e-9 ? p * Math.log(p) : 0), 0))
    : Math.log(3);
  const entN   = c01(ent / Math.log(3));
  const atrPx  = c01(m.spreadPct / 0.05);
  const sprd   = c01(m.spreadPct / 0.1);

  if (v) {
    return [
      cN1(v.score / 100),
      c01(v.confidence / 100),
      cN1(v.components.bookImbalance),
      cN1(v.components.proximityPressure),
      cN1(v.components.microDrift),
      cN1(v.components.momentum),
      cN1(v.components.volumeTrend),
      c01((v.components.rsiPenalty + 0.4) / 0.8),
      sprd,
      cN1(v.components.wallPressure),
      atrPx,
      entN,
      c01(recentWR),
      c01(Math.abs(v.components.momentum)),
    ];
  }

  const microD = m.mid > 0
    ? cN1((m.microPrice - m.mid) / Math.max(m.spread, m.mid * 1e-6) * 2) : 0;
  return [
    0, 0,
    cN1(m.imbalance), cN1(m.proximityImbalance),
    microD, 0, 0, 0.5,
    sprd, cN1(m.imbalance * 0.5),
    atrPx, entN, c01(recentWR), 0,
  ];
}

// ── Decide action from probs ─────────────────────────────────────────────────
function decide(probs: number[], eps: number): { action: RLAction; explored: boolean } {
  const [pL, pS, pH] = probs;
  let action: RLAction;
  let explored = false;
  if (Math.random() < eps) {
    // Softmax sampling (not pure random — biased toward high-prob actions)
    const r = Math.random();
    action = r < pL ? "LONG" : r < pL + pS ? "SHORT" : "HOLD";
    explored = true;
  } else {
    const mx = Math.max(pL, pS, pH);
    action = mx === pL ? "LONG" : mx === pS ? "SHORT" : "HOLD";
  }
  return { action, explored };
}

// ── Confidence = action probability penalised by entropy ───────────────────
function confidence(probs: number[], action: RLAction): number {
  const pA  = action === "LONG" ? probs[0] : action === "SHORT" ? probs[1] : probs[2];
  const ent = -probs.reduce((s, p) => s + (p > 1e-9 ? p * Math.log(p) : 0), 0);
  const cer = 1 - ent / Math.log(3);  // 0 = max uncertainty, 1 = fully certain
  return Math.round(c01(pA) * 100 * (0.5 + 0.5 * cer));
}

// ── Component ────────────────────────────────────────────────────────────────
export function RLAgentPanel({
  verdict, metrics,
}: { verdict: InstitutionalVerdictV2 | null; metrics: BookMetrics | null }) {

  const [active,     setActive]    = useState(false);
  const [thinking,   setThinking]  = useState(false);
  const [current,    setCurrent]   = useState<AgentDecision | null>(null);
  const [log,        setLog]       = useState<AgentDecision[]>([]);
  const [dispExpl,   setDispExpl]  = useState(INIT_EXPL);
  const [dispStep,   setDispStep]  = useState(0);
  const [dispWR,     setDispWR]    = useState(0.5);
  const [dispTrades, setDispTrades]= useState(0);

  // Mutable refs — no re-render cost
  const W        = useRef<W>(initWeights());
  const replay   = useRef<Experience[]>([]);
  const pending  = useRef<PendingReward[]>([]);   // delayed reward queue
  const tickR    = useRef(0);
  const stepR    = useRef(0);
  const winsR    = useRef(0);
  const tradesR  = useRef(0);
  const explR    = useRef(INIT_EXPL);
  const probsR   = useRef<ActionProbs | null>(null);
  const timer    = useRef<ReturnType<typeof setInterval> | null>(null);

  // Prop refs (avoid closure staleness)
  const vRef = useRef(verdict);
  const mRef = useRef(metrics);
  useEffect(() => { vRef.current = verdict; }, [verdict]);
  useEffect(() => { mRef.current = metrics; }, [metrics]);

  const evaluate = useCallback(() => {
    const m = mRef.current;
    const v = vRef.current;
    if (!m || !m.mid) return;

    setThinking(true);
    setTimeout(() => {
      const tick = ++tickR.current;
      const wr   = tradesR.current > 0 ? winsR.current / tradesR.current : 0.5;

      // ── 1. Process matured rewards (decisions made REWARD_TICKS ago) ──────
      const matured = pending.current.filter(p => tick >= p.evalAtTick);
      const remaining = pending.current.filter(p => tick < p.evalAtTick);
      pending.current = remaining;

      for (const p of matured) {
        const priceDeltaPct = (m.mid - p.entry) / p.entry * 100;
        // ATR-normalised reward via tanh → always in (-1, +1), scale-free.
        // spreadPct is a volatility proxy: ATR ≈ 10–20× the bid-ask spread.
        const volProxy = Math.max(m.spreadPct * 12, 0.003); // ~10–15× spread, min 0.003%
        const normalized = priceDeltaPct / volProxy;
        let reward = 0;
        if (p.action === 0) {
          // LONG: positive when price rose (risk-adjusted)
          reward = Math.tanh(normalized);
        } else if (p.action === 1) {
          // SHORT: positive when price fell (risk-adjusted)
          reward = Math.tanh(-normalized);
        } else {
          // HOLD: slight positive in calm markets; penalises missing a clear move
          reward = Math.tanh(-Math.abs(normalized) * 0.6) + 0.12;
        }

        const newState = buildState(v, m, wr, probsR.current);
        replay.current = [
          { state: p.state, action: p.action, reward, nextState: newState },
          ...replay.current,
        ].slice(0, REPLAY_MAX);

        if (replay.current.length >= BATCH) {
          // Prioritised replay: sample high-|reward| experiences more often.
          // Top 60% drawn from highest-|reward| pool; remaining 40% random.
          const sorted = [...replay.current]
            .sort((a, b) => Math.abs(b.reward) - Math.abs(a.reward));
          const splitAt = Math.floor(sorted.length * 0.6);
          const hi = sorted.slice(0, splitAt).sort(() => Math.random() - 0.5);
          const lo = sorted.slice(splitAt).sort(() => Math.random() - 0.5);
          const batchSamples = [...hi, ...lo].slice(0, BATCH);
          W.current = update(W.current, batchSamples);
          stepR.current++;

          if (reward > 0) winsR.current++;
          tradesR.current++;
          explR.current = Math.max(MIN_EXPL, explR.current * EXPL_DECAY);

          if (stepR.current % 4 === 0) {
            setDispStep(stepR.current);
            setDispExpl(explR.current);
            setDispWR(tradesR.current > 0 ? winsR.current / tradesR.current : 0.5);
            setDispTrades(tradesR.current);
          }
        }
      }

      // ── 2. Forward pass → new decision ───────────────────────────────────
      const state  = buildState(v, m, wr, probsR.current);
      const result = fwd(state, W.current);
      const probs: ActionProbs = { long: result.probs[0], short: result.probs[1], hold: result.probs[2] };
      const { action, explored } = decide(result.probs, explR.current);
      const conf = confidence(result.probs, action);

      // Queue this decision for delayed reward evaluation
      pending.current.push({
        state, action: action === "LONG" ? 0 : action === "SHORT" ? 1 : 2,
        entry: m.mid, tick, evalAtTick: tick + REWARD_TICKS,
      });
      probsR.current = probs;

      const dec: AgentDecision = {
        action, probs, confidence: conf,
        score:     v?.score ?? 0,
        timestamp: Date.now(),
        entry:     m.mid,
        tick,
        explored,
      };
      setCurrent(dec);
      setLog(prev => [dec, ...prev].slice(0, 15));
      setThinking(false);
    }, 40);
  }, []); // ← always stable

  // Start / stop interval
  useEffect(() => {
    if (!active) {
      if (timer.current) { clearInterval(timer.current); timer.current = null; }
      return;
    }
    evaluate();
    timer.current = setInterval(evaluate, 2000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [active, evaluate]);

  // Reset on deactivate
  useEffect(() => {
    if (!active) {
      setCurrent(null); setLog([]);
      W.current      = initWeights();
      replay.current = []; pending.current = [];
      tickR.current  = 0; stepR.current = 0;
      winsR.current  = 0; tradesR.current = 0;
      explR.current  = INIT_EXPL;
      probsR.current = null;
      setDispStep(0); setDispExpl(INIT_EXPL); setDispWR(0.5); setDispTrades(0);
    }
  }, [active]);

  const stateVec = active && metrics
    ? buildState(vRef.current, metrics, dispWR, probsR.current)
    : null;

  const fNames = ["Score","Conf","Imbal","WallPx","Micro","Mom","VolDir","RSI","Sprd","WallImb","ATR","Entr","WinR","MomStr"];

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
            {active && <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-primary border-2 border-background animate-pulse" />}
          </div>
          <div>
            <div className="font-bold text-sm flex items-center gap-2">
              RL Agent — عين الحوت
              {active && (
                <>
                  <span className="text-[9px] mono px-1.5 py-0.5 rounded-full bg-primary/20 text-primary border border-primary/30 uppercase tracking-wider">LIVE</span>
                  {dispStep > 0 && (
                    <span className="text-[9px] mono px-1.5 py-0.5 rounded-full bg-bull/20 text-bull border border-bull/30 uppercase tracking-wider flex items-center gap-0.5">
                      <Brain className="size-2.5" /> يتعلم
                    </span>
                  )}
                </>
              )}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {active
                ? thinking
                  ? "جاري التحليل..."
                  : `تيكر #${tickR.current} · خطوات: ${dispStep} · ε=${(dispExpl*100).toFixed(0)}% · أفق: ${REWARD_TICKS} تيكرات`
                : "REINFORCE · مكافأة مُعيَّرة-ATR · إعادة تجربة ذات أولوية · بيس لاين دُفعي"
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
        {active && !metrics && (
          <div className="rounded-xl border border-gold/30 bg-gold/5 p-3 flex items-center gap-2 text-sm text-gold">
            <RefreshCw className="size-4 animate-spin" />
            <span>في انتظار بيانات السوق الحية...</span>
          </div>
        )}

        {active && metrics && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <DecisionCard action={current?.action ?? null} thinking={thinking} explored={current?.explored} />
              <ConfCard     confidence={current?.confidence ?? null} thinking={thinking} />
              <ScoreCard    score={current?.score ?? null} thinking={thinking} />
            </div>

            {current && <ProbBars probs={current.probs} thinking={thinking} />}

            {dispTrades >= 3 && (
              <div className="rounded-xl border border-border bg-secondary/20 p-3 grid grid-cols-4 gap-2 text-center">
                <MiniStat label="الصفقات"    value={String(dispTrades)} />
                <MiniStat label="WinRate"
                  value={`${(dispWR*100).toFixed(0)}%`}
                  color={dispWR>=0.55?"text-bull":dispWR>=0.45?"text-gold":"text-bear"} />
                <MiniStat label="خطوات التعلم" value={String(dispStep)} color="text-primary" />
                <MiniStat label="استكشاف"
                  value={`${(dispExpl*100).toFixed(1)}%`}
                  color={dispExpl<0.06?"text-bull":"text-muted-foreground"} />
              </div>
            )}

            {stateVec && (
              <div className="rounded-xl border border-border bg-secondary/20 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <Database className="size-3 text-primary" /> State Vector
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] mono text-gold">أفق: {REWARD_TICKS} تيكرات</span>
                    <span className="text-[10px] mono bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded-full">{IN} features</span>
                  </div>
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {fNames.map((k, i) => (
                    <FeatCell key={k} name={k} value={stateVec[i] ?? 0} />
                  ))}
                </div>
                {pending.current.length > 0 && (
                  <div className="flex items-center gap-1.5 text-[10px] text-gold mt-1">
                    <Brain className="size-3" />
                    <span>في انتظار تقييم {pending.current.length} قرار · ذاكرة: {replay.current.length}/{REPLAY_MAX}</span>
                  </div>
                )}
              </div>
            )}

            {log.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <Activity className="size-3 text-primary" /> سجل القرارات
                </div>
                <div className="space-y-1 max-h-48 overflow-y-auto rounded-xl border border-border bg-secondary/10 p-2">
                  {log.map(d => (
                    <LogRow key={`${d.tick}-${d.timestamp}`} d={d} isLatest={d.tick===current?.tick} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {!active && (
          <div className="flex flex-col items-center justify-center py-6 gap-3 text-center">
            <div className="size-12 rounded-2xl border border-border bg-secondary/30 flex items-center justify-center">
              <Zap className="size-5 text-muted-foreground" />
            </div>
            <div>
              <div className="text-sm font-semibold">اضغط "تفعيل الوكيل" للبدء</div>
              <div className="text-[11px] text-muted-foreground mt-0.5 max-w-xs mx-auto">
                وكيل تعزيزي حقيقي — مكافأة معيَّرة-ATR، استكشاف ديناميكي، إعادة تجربة ذات أولوية
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-2 text-[10px]">
              <Arch icon={<Brain className="size-3" />}    label="14 مدخل" />
              <Arch icon={<BarChart2 className="size-3" />} label="32-16-3" />
              <Arch icon={<Target className="size-3" />}   label="REINFORCE" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────
function Arch({ icon, label }: { icon: React.ReactNode; label: string }) {
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

function DecisionCard({ action, thinking, explored }: { action: RLAction | null; thinking: boolean; explored?: boolean }) {
  const cfg = {
    LONG:  { color:"text-bull", bg:"bg-bull/8 border-bull/30",  Icon:TrendingUp,   ar:"شراء LONG"  },
    SHORT: { color:"text-bear", bg:"bg-bear/8 border-bear/30",  Icon:TrendingDown, ar:"بيع SHORT"  },
    HOLD:  { color:"text-gold", bg:"bg-gold/8 border-gold/30",  Icon:Minus,        ar:"انتظار HOLD"},
  };
  const c = action ? cfg[action] : null;
  return (
    <div className={cn(
      "rounded-xl border p-3 transition-all relative",
      thinking ? "animate-pulse bg-secondary/30 border-border" : c ? c.bg : "bg-card/40 border-border"
    )}>
      {explored && !thinking && <span className="absolute top-1 left-1 text-[8px] mono text-primary opacity-60">ε</span>}
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

function ConfCard({ confidence, thinking }: { confidence: number | null; thinking: boolean }) {
  const color = confidence === null ? "text-muted-foreground"
    : confidence >= 65 ? "text-bull" : confidence >= 45 ? "text-gold" : "text-bear";
  return (
    <div className="rounded-xl border border-border bg-card/40 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">ثقة الوكيل</div>
      {!thinking && confidence !== null ? (
        <>
          <div className={cn("mono font-black text-lg mt-1", color)}>{confidence}%</div>
          <div className="mt-1.5 h-1.5 rounded-full bg-secondary overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all duration-500",
                confidence>=65?"bg-bull":confidence>=45?"bg-gold":"bg-bear")}
              style={{ width:`${confidence}%` }}
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
  const color = score===null?"text-muted-foreground"
    : score>=15?"text-bull":score<=-15?"text-bear":"text-gold";
  return (
    <div className="rounded-xl border border-border bg-card/40 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">درجة المؤسسي</div>
      {!thinking && score !== null ? (
        <>
          <div className={cn("mono font-black text-lg mt-1", color)}>
            {score>=0?"+":""}{score.toFixed(1)}
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
    { label:"LONG",  v:probs.long,  color:"bg-bull" },
    { label:"HOLD",  v:probs.hold,  color:"bg-gold" },
    { label:"SHORT", v:probs.short, color:"bg-bear" },
  ];
  return (
    <div className="rounded-xl border border-border bg-secondary/20 p-3 space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">توزيع الاحتمالات</div>
      {bars.map(({ label, v, color }) => (
        <div key={label} className="flex items-center gap-2">
          <span className="mono text-[10px] text-muted-foreground w-10 text-left">{label}</span>
          <div className="flex-1 h-3 rounded-full bg-secondary overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all duration-700", color, thinking&&"opacity-40")}
              style={{ width:`${(v*100).toFixed(1)}%` }}
            />
          </div>
          <span className="mono text-[10px] text-muted-foreground w-8 text-left">
            {(v*100).toFixed(0)}%
          </span>
        </div>
      ))}
    </div>
  );
}

function FeatCell({ name, value }: { name: string; value: number }) {
  const color = value>0.05?"text-bull":value<-0.05?"text-bear":"text-muted-foreground";
  return (
    <div className="rounded-lg border border-border bg-card/40 px-1.5 py-1 text-center">
      <div className="text-[8px] text-muted-foreground uppercase tracking-wider truncate">{name}</div>
      <div className={cn("mono text-[10px] font-bold mt-0.5", color)}>
        {value>=0?"+":""}{value.toFixed(2)}
      </div>
    </div>
  );
}

function LogRow({ d, isLatest }: { d: AgentDecision; isLatest: boolean }) {
  const time  = new Date(d.timestamp).toLocaleTimeString("ar", { hour:"2-digit", minute:"2-digit", second:"2-digit" });
  const color = { LONG:"text-bull", SHORT:"text-bear", HOLD:"text-gold" }[d.action];
  const bg    = { LONG:"bg-bull/5 border-bull/20", SHORT:"bg-bear/5 border-bear/20", HOLD:"bg-secondary/20 border-border/50" }[d.action];
  return (
    <div className={cn(
      "flex items-center justify-between px-2.5 py-1.5 rounded-lg text-[11px] mono border",
      isLatest ? "ring-1 ring-primary/30 "+bg : bg
    )}>
      <span className="text-muted-foreground w-16">{time}</span>
      <span className={cn("font-black w-12 text-center", color)}>{d.action}</span>
      <span className="text-muted-foreground w-14 text-center">{d.confidence}%</span>
      <span className="text-muted-foreground">{fmtPrice(d.entry)}</span>
      {d.explored && <span className="text-[8px] text-primary w-3">ε</span>}
      <span className="text-muted-foreground text-[9px] w-10 text-left">#{d.tick}</span>
    </div>
  );
}
