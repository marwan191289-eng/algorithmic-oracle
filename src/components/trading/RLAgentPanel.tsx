import { useState, useEffect, useRef, useCallback } from "react";
import type { InstitutionalVerdictV2, BookMetrics } from "@/lib/analysis";
import { cn } from "@/lib/utils";
import {
  Bot, Power, TrendingUp, TrendingDown, Minus,
  Activity, Database, Zap, RefreshCw, Brain, Target,
  BarChart2, ShieldCheck, AlertCircle, Loader2,
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
  entry: number;
  tick: number;
  evalAtTick: number;
}

interface Experience {
  state: number[];
  action: number;
  reward: number;
  nextState: number[];
}

// Consensus: majority vote across last CONSENSUS_WINDOW decisions
interface Consensus {
  action: RLAction;
  conviction: number;   // 0..1 — fraction of last N decisions agreeing
  phase: "calibrating" | "converging" | "stable";
  actionable: boolean;  // true only when conviction ≥ threshold AND phase = stable
}

// ── Constants ──────────────────────────────────────────────────────────────
const IN   = 17;
const H1   = 32;
const H2   = 16;
const OUT  = 3;
const LR          = 0.004;
const ENTROPY_C   = 0.08;
const BATCH       = 24;
const REPLAY_MAX  = 800;
const REWARD_TICKS= 5;
const INIT_EXPL   = 0.22;
const MIN_EXPL    = 0.04;
const EXPL_DECAY  = 0.9985;

const CONSENSUS_WINDOW   = 7;   // majority vote over last 7 decisions
const CONSENSUS_THRESH   = 0.65; // 5/7 agreement → actionable
const CALIBRATING_TICKS  = 40;
const CONVERGING_TICKS   = 120;

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

function initWeights(): W {
  const r1 = Math.sqrt(6 / (IN + H1));
  const r2 = Math.sqrt(6 / (H1 + H2));
  const r3 = Math.sqrt(6 / (H2 + OUT));
  const rng = (r: number) => (Math.random() * 2 - 1) * r;

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
  const b3 = [0.0, 0.0, 0.15];

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
function update(w: W, batch: Experience[]): W {
  const nW1 = w.W1.map(r => [...r]), nb1 = [...w.b1];
  const nW2 = w.W2.map(r => [...r]), nb2 = [...w.b2];
  const nW3 = w.W3.map(r => [...r]), nb3 = [...w.b3];
  const clipG = (v: number) => Math.max(-2.0, Math.min(2.0, v));
  const clipW = (v: number) => Math.max(-3.0, Math.min(3.0, v));

  const rewards = batch.map(e => e.reward);
  const meanR = rewards.reduce((s, r) => s + r, 0) / rewards.length;
  const varR  = rewards.reduce((s, r) => s + (r - meanR) ** 2, 0) / rewards.length;
  const stdR  = Math.sqrt(varR) || 1;

  for (const ex of batch) {
    const f = fwd(ex.state, w);
    const { h1, h1p, h2, h2p, probs } = f;

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
  const ent  = lastProbs
    ? -([lastProbs.long, lastProbs.short, lastProbs.hold].reduce((s, p) => s + (p > 1e-9 ? p * Math.log(p) : 0), 0))
    : Math.log(3);
  const entN  = c01(ent / Math.log(3));
  const atrPx = c01(m.spreadPct / 0.05);
  const sprd  = c01(m.spreadPct / 0.1);

  if (v) {
    const regime = v.compositeScore?.regime ?? "ranging";
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
      c01(v.components.spreadHealth),
      regime === "trending" ? 1 : 0,
      regime === "volatile" ? 1 : 0,
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
    c01(1 - sprd), 0, 0,
  ];
}

// ── Decide action from probs ─────────────────────────────────────────────────
function decide(probs: number[], eps: number): { action: RLAction; explored: boolean } {
  const [pL, pS, pH] = probs;
  let action: RLAction;
  let explored = false;
  if (Math.random() < eps) {
    const r = Math.random();
    action = r < pL ? "LONG" : r < pL + pS ? "SHORT" : "HOLD";
    explored = true;
  } else {
    const mx = Math.max(pL, pS, pH);
    action = mx === pL ? "LONG" : mx === pS ? "SHORT" : "HOLD";
  }
  return { action, explored };
}

function confidence(probs: number[], action: RLAction): number {
  const pA  = action === "LONG" ? probs[0] : action === "SHORT" ? probs[1] : probs[2];
  const ent = -probs.reduce((s, p) => s + (p > 1e-9 ? p * Math.log(p) : 0), 0);
  const cer = 1 - ent / Math.log(3);
  return Math.round(c01(pA) * 100 * (0.5 + 0.5 * cer));
}

// ── Compute consensus from last N decisions ─────────────────────────────────
function computeConsensus(log: AgentDecision[], tick: number): Consensus | null {
  if (log.length < 3) return null;
  const window = log.slice(0, CONSENSUS_WINDOW);
  const counts: Record<RLAction, number> = { LONG: 0, SHORT: 0, HOLD: 0 };
  window.forEach(d => counts[d.action]++);
  const top = (Object.entries(counts) as [RLAction, number][])
    .sort(([, a], [, b]) => b - a)[0];
  const conviction = top[1] / window.length;
  const phase: Consensus["phase"] =
    tick < CALIBRATING_TICKS ? "calibrating" :
    tick < CONVERGING_TICKS  ? "converging"  : "stable";
  const actionable = phase === "stable" && conviction >= CONSENSUS_THRESH;
  return { action: top[0], conviction, phase, actionable };
}

// ── Component ────────────────────────────────────────────────────────────────
export function RLAgentPanel({
  verdict, metrics,
}: { verdict: InstitutionalVerdictV2 | null; metrics: BookMetrics | null }) {

  const [active,     setActive]    = useState(false);
  const [thinking,   setThinking]  = useState(false);
  const [log,        setLog]       = useState<AgentDecision[]>([]);
  const [consensus,  setConsensus] = useState<Consensus | null>(null);
  const [dispExpl,   setDispExpl]  = useState(INIT_EXPL);
  const [dispStep,   setDispStep]  = useState(0);
  const [dispWR,     setDispWR]    = useState(0.5);
  const [dispTrades, setDispTrades]= useState(0);

  const W        = useRef<W>(initWeights());
  const replay   = useRef<Experience[]>([]);
  const pending  = useRef<PendingReward[]>([]);
  const logRef   = useRef<AgentDecision[]>([]);
  const tickR    = useRef(0);
  const stepR    = useRef(0);
  const winsR    = useRef(0);
  const tradesR  = useRef(0);
  const explR    = useRef(INIT_EXPL);
  const probsR   = useRef<ActionProbs | null>(null);
  const timer    = useRef<ReturnType<typeof setInterval> | null>(null);

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

      // ── 1. Process matured rewards ───────────────────────────────────────
      const matured   = pending.current.filter(p => tick >= p.evalAtTick);
      pending.current = pending.current.filter(p => tick < p.evalAtTick);

      for (const p of matured) {
        const priceDeltaPct = (m.mid - p.entry) / p.entry * 100;
        const volProxy = Math.max(m.spreadPct * 12, 0.003);
        const normalized = priceDeltaPct / volProxy;
        let reward = 0;
        if (p.action === 0) {
          reward = Math.tanh(normalized);
        } else if (p.action === 1) {
          reward = Math.tanh(-normalized);
        } else {
          reward = Math.tanh(-Math.abs(normalized) * 0.6) + 0.12;
        }

        const newState = buildState(v, m, wr, probsR.current);
        replay.current = [
          { state: p.state, action: p.action, reward, nextState: newState },
          ...replay.current,
        ].slice(0, REPLAY_MAX);

        if (replay.current.length >= BATCH) {
          const sorted = [...replay.current]
            .sort((a, b) => Math.abs(b.reward) - Math.abs(a.reward));
          const splitAt = Math.floor(sorted.length * 0.6);
          const hi = sorted.slice(0, splitAt).sort(() => Math.random() - 0.5);
          const lo = sorted.slice(splitAt).sort(() => Math.random() - 0.5);
          W.current = update(W.current, [...hi, ...lo].slice(0, BATCH));
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

      // Update log ref (mutable, no re-render cost)
      logRef.current = [dec, ...logRef.current].slice(0, 15);

      // Compute consensus and update state
      const newConsensus = computeConsensus(logRef.current, tick);
      setConsensus(newConsensus);
      setLog([...logRef.current]);
      setThinking(false);
    }, 40);
  }, []);

  useEffect(() => {
    if (!active) {
      if (timer.current) { clearInterval(timer.current); timer.current = null; }
      return;
    }
    evaluate();
    timer.current = setInterval(evaluate, 2000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [active, evaluate]);

  useEffect(() => {
    if (!active) {
      setLog([]);
      setConsensus(null);
      W.current      = initWeights();
      replay.current = []; pending.current = [];
      logRef.current = [];
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

  const fNames = ["Score","Conf","Imbal","WallPx","Micro","Mom","VolDir","RSI","Sprd","WallImb","ATR","Entr","WinR","MomStr","SprdH","Trend","VolReg"];
  const current = log[0] ?? null;

  return (
    <div className={cn(
      "rounded-2xl border overflow-hidden transition-all duration-300",
      active
        ? "border-primary/50 bg-card/70 shadow-[0_0_24px_rgba(99,102,241,.15)]"
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
                  : `تيكر #${tickR.current} · خطوات: ${dispStep} · ε=${(dispExpl*100).toFixed(0)}% · توافق آخر ${CONSENSUS_WINDOW}`
                : "REINFORCE · مكافأة معيَّرة-ATR · إعادة تجربة ذات أولوية · توافق إجماعي"
              }
            </div>
          </div>
        </div>
        <button
          onClick={() => setActive(v => !v)}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-xl text-[12px] font-bold border transition-all",
            active
              ? "bg-primary text-primary-foreground border-primary shadow-[0_0_12px_rgba(99,102,241,.4)] hover:opacity-90"
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
            {/* ── Consensus signal (PRIMARY display) ──────────────────── */}
            <ConsensusCard consensus={consensus} thinking={thinking} tick={tickR.current} />

            {/* ── Per-action probabilities ──────────────────────────── */}
            {current && <ProbBars probs={current.probs} thinking={thinking} />}

            {/* ── Phase explanation ─────────────────────────────────── */}
            {consensus && consensus.phase !== "stable" && (
              <div className="rounded-xl border border-gold/30 bg-gold/5 px-3 py-2 text-[11px] text-gold flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin" />
                {consensus.phase === "calibrating"
                  ? `مرحلة المعايرة — الوكيل يستكشف السوق (${tickR.current}/${CALIBRATING_TICKS} تيكر). الإشارات غير مستقرة بعد.`
                  : `مرحلة التقارب — الوكيل يبدأ بالاستقرار (${tickR.current}/${CONVERGING_TICKS} تيكر). المزيد من البيانات تحسّن الدقة.`}
              </div>
            )}

            {/* ── Learning stats ──────────────────────────────────── */}
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

            {/* ── State vector ─────────────────────────────────────── */}
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

            {/* ── Decision log (sequential ticks, not simultaneous) ── */}
            {log.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <Activity className="size-3 text-primary" />
                  سجل القرارات المتتالية — كل سطر = تيكر مستقل (2 ثانية)
                </div>
                <div className="space-y-1 max-h-48 overflow-y-auto rounded-xl border border-border bg-secondary/10 p-2">
                  {log.map(d => (
                    <LogRow key={`${d.tick}-${d.timestamp}`} d={d} isLatest={d.tick === log[0]?.tick} />
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
              <div className="text-[11px] text-muted-foreground mt-0.5 max-w-sm mx-auto">
                يعمل بقرارات مستقلة كل 2 ثانية. الإشارة الموثوقة تظهر بعد ~{CONVERGING_TICKS} تيكر (≈4 دقائق) حين يبلغ الوكيل التقارب.
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-2 text-[10px]">
              <Arch icon={<Brain className="size-3" />}    label="14 مدخل" />
              <Arch icon={<BarChart2 className="size-3" />} label="32-16-3" />
              <Arch icon={<Target className="size-3" />}   label="إجماع 7 تيكرات" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Consensus Card (replaces single-tick DecisionCard) ──────────────────────
function ConsensusCard({ consensus, thinking, tick }: {
  consensus: Consensus | null;
  thinking: boolean;
  tick: number;
}) {
  if (thinking && !consensus) return (
    <div className="rounded-xl border border-border bg-secondary/20 p-4 flex items-center justify-center gap-2 text-muted-foreground text-sm">
      <Loader2 className="size-4 animate-spin" /> جاري التحليل...
    </div>
  );

  if (!consensus || tick < 3) return (
    <div className="rounded-xl border border-border bg-secondary/20 p-4 text-center text-[12px] text-muted-foreground">
      جاري جمع البيانات... ({tick}/3 تيكرات)
    </div>
  );

  const { action, conviction, phase, actionable } = consensus;
  const convPct = Math.round(conviction * 100);

  const actionColor =
    action === "LONG"  ? "text-bull"  :
    action === "SHORT" ? "text-bear"  : "text-muted-foreground";
  const actionBg =
    action === "LONG"  ? "bg-bull/10 border-bull/30"  :
    action === "SHORT" ? "bg-bear/10 border-bear/30"  : "bg-secondary/20 border-border";
  const ActionIcon =
    action === "LONG"  ? TrendingUp   :
    action === "SHORT" ? TrendingDown : Minus;

  return (
    <div className={cn("rounded-xl border p-4 space-y-3", actionBg)}>
      {/* Label */}
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <ShieldCheck className="size-3" />
          إجماع الوكيل (آخر {Math.min(tick, CONSENSUS_WINDOW)} تيكرات)
        </div>
        <span className={cn(
          "text-[9px] mono px-2 py-0.5 rounded-full border font-semibold",
          phase === "calibrating" ? "text-gold border-gold/30 bg-gold/10"
          : phase === "converging" ? "text-primary border-primary/30 bg-primary/10"
          : actionable ? "text-bull border-bull/30 bg-bull/10" : "text-muted-foreground border-border"
        )}>
          {phase === "calibrating" ? "معايرة" : phase === "converging" ? "تقارب" : actionable ? "✓ قابل للتنفيذ" : "غير كافٍ"}
        </span>
      </div>

      {/* Main signal */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={cn("size-12 rounded-xl border flex items-center justify-center", actionBg)}>
            <ActionIcon className={cn("size-6", actionColor)} />
          </div>
          <div>
            <div className={cn("text-2xl font-black mono", actionColor)}>
              {action === "LONG" ? "شراء" : action === "SHORT" ? "بيع" : "انتظار"}
            </div>
            <div className="text-[10px] text-muted-foreground">{action}</div>
          </div>
        </div>

        {/* Conviction bar */}
        <div className="text-right space-y-1">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">الاقتناع</div>
          <div className={cn("text-2xl font-black mono",
            convPct >= 70 ? "text-bull" : convPct >= 50 ? "text-gold" : "text-bear"
          )}>{convPct}%</div>
          <div className="w-24 h-1.5 rounded-full bg-secondary overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all",
                convPct >= 70 ? "bg-bull" : convPct >= 50 ? "bg-gold" : "bg-bear"
              )}
              style={{ width: `${convPct}%` }}
            />
          </div>
        </div>
      </div>

      {/* Warning when not actionable */}
      {!actionable && phase === "stable" && (
        <div className="flex items-center gap-1.5 text-[10px] text-gold">
          <AlertCircle className="size-3" />
          الاقتناع {convPct}% &lt; {Math.round(CONSENSUS_THRESH*100)}% — إشارة مترددة، لا تتصرف الآن
        </div>
      )}
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

function ProbBars({ probs, thinking }: { probs: ActionProbs; thinking: boolean }) {
  const bars: { label: string; key: keyof ActionProbs; color: string }[] = [
    { label: "LONG",  key: "long",  color: "bg-bull"  },
    { label: "HOLD",  key: "hold",  color: "bg-muted-foreground" },
    { label: "SHORT", key: "short", color: "bg-bear"  },
  ];
  return (
    <div className="rounded-xl border border-border bg-secondary/20 p-3 space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
        <BarChart2 className="size-3 text-primary" /> احتمالية كل إجراء (آخر تيكر)
      </div>
      {bars.map(({ label, key, color }) => {
        const pct = Math.round(probs[key] * 100);
        return (
          <div key={key} className="flex items-center gap-2">
            <div className="text-[10px] mono w-10 text-muted-foreground">{label}</div>
            <div className="flex-1 h-2 rounded-full bg-secondary overflow-hidden">
              <div
                className={cn("h-full rounded-full transition-all", color, thinking ? "opacity-40" : "")}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="text-[10px] mono w-8 text-right text-muted-foreground">{pct}%</div>
          </div>
        );
      })}
    </div>
  );
}

function FeatCell({ name, value }: { name: string; value: number }) {
  const abs = Math.abs(value);
  const bg =
    abs < 0.15 ? "bg-secondary/30" :
    value > 0  ? "bg-bull/20 border-bull/20" :
                 "bg-bear/20 border-bear/20";
  return (
    <div className={cn("rounded p-1 text-center border border-transparent text-[8px]", bg)}>
      <div className="text-muted-foreground leading-tight">{name}</div>
      <div className={cn("mono font-bold leading-tight", value > 0.1 ? "text-bull" : value < -0.1 ? "text-bear" : "text-foreground")}>
        {value >= 0 ? "+" : ""}{value.toFixed(2)}
      </div>
    </div>
  );
}

function LogRow({ d, isLatest }: { d: AgentDecision; isLatest: boolean }) {
  const col =
    d.action === "LONG"  ? "text-bull"  :
    d.action === "SHORT" ? "text-bear"  : "text-muted-foreground";
  const Icon =
    d.action === "LONG"  ? TrendingUp   :
    d.action === "SHORT" ? TrendingDown : Minus;
  const now = Date.now();
  const secAgo = Math.round((now - d.timestamp) / 1000);

  return (
    <div className={cn(
      "flex items-center gap-2 px-2 py-1 rounded text-[10px] mono transition-colors",
      isLatest ? "bg-primary/10 border border-primary/20" : d.explored ? "opacity-40" : "opacity-70",
    )}>
      <span className="text-muted-foreground w-6 text-right">{d.tick}</span>
      <Icon className={cn("size-3 flex-shrink-0", col)} />
      <span className={cn("font-bold w-10", col)}>{d.action}</span>
      <span className="text-muted-foreground flex-1">
        conf {d.confidence}% · L{(d.probs.long*100).toFixed(0)} S{(d.probs.short*100).toFixed(0)} H{(d.probs.hold*100).toFixed(0)}
      </span>
      <span className="text-muted-foreground/60">
        {isLatest ? "الآن" : `${secAgo}s`}
        {d.explored && <span className="text-gold/60 mr-1">ε</span>}
      </span>
    </div>
  );
}
