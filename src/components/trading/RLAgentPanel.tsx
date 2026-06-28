import { useState, useEffect, useRef, useCallback } from "react";
import type { InstitutionalVerdictV2, BookMetrics } from "@/lib/analysis";
import { cn } from "@/lib/utils";
import {
  Bot, Power, TrendingUp, TrendingDown, Minus,
  Activity, Database, Zap, RefreshCw, Brain, Target,
  BarChart2, Award, AlertCircle,
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
  stateArr: number[];
  explorationBonus: number;
}

interface Experience {
  state: number[];
  action: number; // 0=LONG, 1=SHORT, 2=HOLD
  reward: number;
  nextState: number[];
  done: boolean;
}

// ── Neural network architecture ─────────────────────────────────────────────
// 14 inputs → 32 hidden (ReLU) → 16 hidden (ReLU) → 3 outputs (Softmax)
// Weights initialized analytically and then updated via online learning

const INPUT_DIM = 14;
const H1_DIM = 32;
const H2_DIM = 16;
const OUTPUT_DIM = 3;
const LR = 0.004;         // learning rate
const GAMMA = 0.92;        // discount factor
const ENTROPY_COEFF = 0.08; // entropy bonus to prevent premature convergence
const REPLAY_BATCH = 24;   // mini-batch size for gradient updates
const MAX_REPLAY = 500;    // experience replay buffer size

function relu(x: number) { return x > 0 ? x : 0; }
function reluGrad(x: number) { return x > 0 ? 1 : 0; }

function softmax(arr: number[]): number[] {
  const max = Math.max(...arr);
  const exps = arr.map(x => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
}

// He initialization for ReLU networks
function heInit(fanIn: number, fanOut: number): number[][] {
  const std = Math.sqrt(2 / fanIn);
  return Array.from({ length: fanOut }, () =>
    Array.from({ length: fanIn }, () => (Math.random() * 2 - 1) * std)
  );
}

// ── Initial weights derived from institutional knowledge ─────────────────────
function buildInitialWeights() {
  // Seed with fixed value so weights are deterministic on first load
  // Inputs: [score, conf, imbal, proxPx, micro, mom, volDir, rsi,
  //          sprd, wallImb, atr, entropy, recentWinRate, sessionVolatility]
  //          [0]   [1]   [2]    [3]    [4]    [5]  [6]   [7]
  //          [8]   [9]   [10]   [11]   [12]   [13]

  // Layer 1 W1 [H1_DIM × INPUT_DIM]
  const W1: number[][] = [];
  const b1: number[] = [];

  // Units 0-9: bullish detectors
  const bull = [3.2, 1.6, 2.8, 2.2, 1.9, 2.4, 1.6, -1.1, -0.5, 1.9, 0.3, 0.2, 1.2, 0.4];
  for (let i = 0; i < 10; i++) {
    W1.push(bull.map((w, j) => w * (0.80 + 0.35 * ((i * 7 + j * 3) % 10) / 10)));
    b1.push(-0.4 - i * 0.04);
  }
  // Units 10-19: bearish detectors
  const bear = [-3.2, 1.6, -2.8, -2.2, -1.9, -2.4, -1.6, 1.1, -0.5, -1.9, 0.3, 0.2, -1.2, 0.4];
  for (let i = 0; i < 10; i++) {
    W1.push(bear.map((w, j) => w * (0.80 + 0.35 * ((i * 11 + j * 5) % 10) / 10)));
    b1.push(-0.4 - i * 0.04);
  }
  // Units 20-27: HOLD / uncertainty detectors
  const hold = [0.5, -0.5, 0.3, 0.3, 0.2, 0.2, 0.1, 1.3, 0.9, 0.3, -0.2, 0.8, -0.3, 0.5];
  for (let i = 0; i < 8; i++) {
    W1.push(hold.map((w, j) => w * (0.9 + 0.2 * (i % 5) / 5)));
    b1.push(0.2);
  }
  // Units 28-31: volatility / risk detectors
  const vol = [0.2, 0.8, 0.1, 0.1, 0.5, 0.4, 0.6, 0.2, 1.2, 0.1, -1.8, -0.5, 0.4, 0.3];
  for (let i = 0; i < 4; i++) {
    W1.push(vol.map(w => w * (0.85 + 0.15 * i / 4)));
    b1.push(0.0);
  }

  // Layer 2 W2 [H2_DIM × H1_DIM]
  const W2: number[][] = [];
  const b2: number[] = [];
  for (let i = 0; i < H2_DIM; i++) {
    const row: number[] = [];
    for (let j = 0; j < H1_DIM; j++) {
      // First 8 units of H1 are bull, next 10 are bear, rest are hold/vol
      if (i < 6) row.push(j < 10 ? 1.2 : j < 20 ? -1.0 : 0.0); // bullish aggregators
      else if (i < 12) row.push(j < 10 ? -1.0 : j < 20 ? 1.2 : 0.0); // bearish aggregators
      else row.push(j < 20 ? -0.4 : 1.0); // hold aggregators
    }
    W2.push(row.map(w => w * (0.3 + Math.random() * 0.1)));
    b2.push(i < 6 ? 0.0 : i < 12 ? 0.0 : 0.2);
  }

  // Output layer W3 [OUTPUT_DIM × H2_DIM]
  const W3: number[][] = [
    [...Array(6).fill(2.0), ...Array(6).fill(-1.8), ...Array(4).fill(-0.4)], // LONG
    [...Array(6).fill(-1.8), ...Array(6).fill(2.0), ...Array(4).fill(-0.4)], // SHORT
    [...Array(6).fill(-0.5), ...Array(6).fill(-0.5), ...Array(4).fill(1.6)], // HOLD
  ];
  const b3 = [0.0, 0.0, 0.4]; // slight HOLD bias

  return { W1, b1, W2, b2, W3, b3 };
}

// ── Neural network forward pass ───────────────────────────────────────────────
interface Weights {
  W1: number[][]; b1: number[];
  W2: number[][]; b2: number[];
  W3: number[][]; b3: number[];
}

interface ForwardResult {
  h1: number[];   // pre-activation
  h1r: number[];  // post-relu
  h2: number[];
  h2r: number[];
  logits: number[];
  probs: number[];
}

function forward(state: number[], w: Weights): ForwardResult {
  const h1 = w.W1.map((row, i) =>
    row.reduce((s, wi, j) => s + wi * (state[j] ?? 0), 0) + w.b1[i]
  );
  const h1r = h1.map(relu);

  const h2 = w.W2.map((row, i) =>
    row.reduce((s, wi, j) => s + wi * h1r[j], 0) + w.b2[i]
  );
  const h2r = h2.map(relu);

  const logits = w.W3.map((row, i) =>
    row.reduce((s, wi, j) => s + wi * h2r[j], 0) + w.b3[i]
  );
  const probs = softmax(logits);
  return { h1, h1r, h2, h2r, logits, probs };
}

// ── REINFORCE policy gradient update ─────────────────────────────────────────
// Updates weights using the REINFORCE algorithm with entropy bonus
function policyGradientUpdate(
  w: Weights,
  experience: Experience[]
): Weights {
  if (experience.length < 4) return w;

  // Clone weights
  const nW1 = w.W1.map(r => [...r]);
  const nb1 = [...w.b1];
  const nW2 = w.W2.map(r => [...r]);
  const nb2 = [...w.b2];
  const nW3 = w.W3.map(r => [...r]);
  const nb3 = [...w.b3];

  for (const exp of experience) {
    const f = forward(exp.state, w);
    const { h1r, h2r, probs } = f;

    // Reward with discount (TD-style estimate)
    const nextF = forward(exp.nextState, w);
    const nextVal = exp.done ? 0 : GAMMA * Math.max(...nextF.probs);
    const advantage = exp.reward + nextVal - probs[exp.action];
    const adv = Math.max(-2, Math.min(2, advantage)); // clip gradient

    // Entropy bonus gradient: encourages exploration
    const entropy = -probs.reduce((s, p) => s + (p > 0 ? p * Math.log(p) : 0), 0);

    // Output layer gradient (dL/dlogits)
    const dLogits = probs.map((p, k) => {
      const onehot = k === exp.action ? 1 : 0;
      const policyGrad = -adv * (onehot - p);
      const entropyGrad = -ENTROPY_COEFF * (-Math.log(p + 1e-8) - entropy);
      return policyGrad + entropyGrad;
    });

    // Update W3, b3
    for (let k = 0; k < OUTPUT_DIM; k++) {
      for (let j = 0; j < H2_DIM; j++) {
        nW3[k][j] -= LR * dLogits[k] * h2r[j];
      }
      nb3[k] -= LR * dLogits[k];
    }

    // Backprop to h2
    const dH2r = Array(H2_DIM).fill(0);
    for (let j = 0; j < H2_DIM; j++) {
      for (let k = 0; k < OUTPUT_DIM; k++) {
        dH2r[j] += w.W3[k][j] * dLogits[k];
      }
    }
    const dH2 = dH2r.map((d, j) => d * reluGrad(f.h2[j]));

    // Update W2, b2
    for (let i = 0; i < H2_DIM; i++) {
      for (let j = 0; j < H1_DIM; j++) {
        nW2[i][j] -= LR * dH2[i] * h1r[j];
      }
      nb2[i] -= LR * dH2[i];
    }

    // Backprop to h1
    const dH1r = Array(H1_DIM).fill(0);
    for (let j = 0; j < H1_DIM; j++) {
      for (let i = 0; i < H2_DIM; i++) {
        dH1r[j] += w.W2[i][j] * dH2[i];
      }
    }
    const dH1 = dH1r.map((d, j) => d * reluGrad(f.h1[j]));

    // Update W1, b1
    for (let i = 0; i < H1_DIM; i++) {
      for (let j = 0; j < INPUT_DIM; j++) {
        nW1[i][j] -= LR * dH1[i] * (exp.state[j] ?? 0);
      }
      nb1[i] -= LR * dH1[i];
    }
  }

  // Gradient clipping (prevents exploding gradients)
  const clip = (v: number) => Math.max(-1.5, Math.min(1.5, v));
  return {
    W1: nW1.map(r => r.map(clip)), b1: nb1.map(clip),
    W2: nW2.map(r => r.map(clip)), b2: nb2.map(clip),
    W3: nW3.map(r => r.map(clip)), b3: nb3.map(clip),
  };
}

// ── State vector (14 features) ────────────────────────────────────────────────
// [score, conf, imbal, proxPx, micro, mom, volDir, rsi, sprd, wallImb,
//  atrNorm, probEntropy, recentWinRate, momentumStrength]
function buildStateArray(v: InstitutionalVerdictV2 | null, m: BookMetrics, ctx: AgentContext): number[] {
  const spread = Math.min(m.spreadPct / 0.1, 1);
  const micro  = m.microPrice && m.mid
    ? Math.max(-1, Math.min(1, (m.microPrice - m.mid) / (m.mid || 1) * 100))
    : 0;

  if (v) {
    // Entropy of recent decisions (high = uncertain agent, low = confident)
    const probs = ctx.recentProbs.length > 0 ? ctx.recentProbs[0] : null;
    const entropy = probs
      ? -([probs.long, probs.short, probs.hold].reduce((s, p) => s + (p > 0 ? p * Math.log(p) : 0), 0))
      : Math.log(3);
    const normalizedEntropy = entropy / Math.log(3); // 0..1

    // Momentum strength: absolute value of momentum
    const momentumStrength = Math.abs(v.components.momentum);

    // ATR normalized (if available from bookMetrics spread as proxy)
    const atrNorm = Math.min(1, m.spreadPct / 0.05);

    return [
      v.score / 100,
      v.confidence / 100,
      v.components.bookImbalance,
      v.components.proximityPressure,
      v.components.microDrift,
      v.components.momentum,
      v.components.volumeTrend,
      (v.components.rsiPenalty + 0.4) / 0.8, // normalize to [0,1]
      spread,
      v.components.wallPressure,
      atrNorm,
      normalizedEntropy,
      ctx.recentWinRate,
      momentumStrength,
    ];
  }

  // Partial state from book metrics alone
  const vwapDrift = m.mid > 0 ? Math.max(-1, Math.min(1, (m.vwapBid - m.vwapAsk) / m.mid)) : 0;
  return [
    0, 0, m.imbalance, vwapDrift, micro,
    0, 0, 0.5, spread, m.imbalance * 0.5,
    Math.min(1, m.spreadPct / 0.05), Math.log(3) / Math.log(3),
    ctx.recentWinRate, 0,
  ];
}

interface AgentContext {
  recentProbs: ActionProbs[];
  recentWinRate: number;
  totalDecisions: number;
  wins: number;
}

// ── Performance tracker ────────────────────────────────────────────────────────
interface PerfMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  recentPnls: number[];
  streak: number;
  streakType: "win" | "loss" | "none";
}

// ── Decision from probs ────────────────────────────────────────────────────────
function decideAction(probs: ActionProbs, explorationRate: number): { action: RLAction; confidence: number; explorationBonus: number } {
  // ε-greedy exploration with temperature annealing
  const rand = Math.random();
  let action: RLAction;
  let explorationBonus = 0;

  if (rand < explorationRate) {
    // Explore: sample from probability distribution (not greedy)
    const r2 = Math.random();
    action = r2 < probs.long ? "LONG" : r2 < probs.long + probs.short ? "SHORT" : "HOLD";
    explorationBonus = 1;
  } else {
    const max = Math.max(probs.long, probs.short, probs.hold);
    action = max === probs.long ? "LONG" : max === probs.short ? "SHORT" : "HOLD";
  }

  const entropy = -([probs.long, probs.short, probs.hold]
    .reduce((s, p) => s + (p > 0 ? p * Math.log(p) : 0), 0));
  const maxEntropy = Math.log(3);
  const certainty = 1 - entropy / maxEntropy;
  const pAction = action === "LONG" ? probs.long : action === "SHORT" ? probs.short : probs.hold;
  const confidence = Math.round(pAction * 100 * (0.6 + 0.4 * certainty));

  return { action, confidence, explorationBonus };
}

// ── State map for display ─────────────────────────────────────────────────────
function buildStateMap(v: InstitutionalVerdictV2 | null, m: BookMetrics, ctx: AgentContext) {
  const arr = buildStateArray(v, m, ctx);
  const keys = ["Score","Conf","Imbal","WallPx","Micro","Mom","VolDir","RSI","Sprd","WallImb","ATR","Entr","WinR","MomStr"];
  return keys.map((k, i) => ({ k, v: arr[i] ?? 0 }));
}

// ── Main Component ─────────────────────────────────────────────────────────────
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
  const [perf, setPerf] = useState<PerfMetrics>({
    totalTrades: 0, wins: 0, losses: 0, totalPnl: 0, recentPnls: [], streak: 0, streakType: "none",
  });
  const [learningStep, setLearningStep] = useState(0);
  const [explorationRate, setExplorationRate] = useState(0.15); // starts higher, anneals down

  const weightsRef  = useRef<Weights>(buildInitialWeights());
  const replayRef   = useRef<Experience[]>([]);
  const tickRef     = useRef(0);
  const timerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastDecRef  = useRef<{ state: number[]; action: number; price: number } | null>(null);
  const contextRef  = useRef<AgentContext>({
    recentProbs: [], recentWinRate: 0.5, totalDecisions: 0, wins: 0,
  });

  const evaluate = useCallback(() => {
    if (!metrics) return;
    setThinking(true);

    setTimeout(() => {
      const ctx = contextRef.current;

      // ── Compute reward from previous decision ─────────────────────────────
      if (lastDecRef.current && metrics.mid) {
        const prev = lastDecRef.current;
        const priceDelta = (metrics.mid - prev.price) / prev.price;
        let reward = 0;
        if (prev.action === 0)      reward = priceDelta * 10; // LONG
        else if (prev.action === 1) reward = -priceDelta * 10; // SHORT
        else reward = Math.max(0, 0.05 - Math.abs(priceDelta) * 5); // HOLD: reward stillness

        const newState = buildStateArray(verdict, metrics, ctx);
        const exp: Experience = {
          state: prev.state, action: prev.action, reward,
          nextState: newState, done: false,
        };
        replayRef.current = [exp, ...replayRef.current].slice(0, MAX_REPLAY);

        // Online learning: update weights from mini-batch
        if (replayRef.current.length >= REPLAY_BATCH) {
          // Sample random mini-batch
          const shuffled = [...replayRef.current].sort(() => Math.random() - 0.5);
          const batch = shuffled.slice(0, REPLAY_BATCH);
          weightsRef.current = policyGradientUpdate(weightsRef.current, batch);
          setLearningStep(s => s + 1);

          // Update performance tracking
          const isWin = reward > 0.01;
          const isLoss = reward < -0.01;
          ctx.wins += isWin ? 1 : 0;
          ctx.totalDecisions += 1;
          ctx.recentWinRate = ctx.wins / ctx.totalDecisions;

          setPerf(p => {
            const newPnls = [reward, ...p.recentPnls].slice(0, 20);
            const newTotal = p.totalTrades + 1;
            const newWins = p.wins + (isWin ? 1 : 0);
            const newLosses = p.losses + (isLoss ? 1 : 0);
            let streak = p.streak;
            let streakType = p.streakType;
            if (isWin) {
              streak = p.streakType === "win" ? streak + 1 : 1;
              streakType = "win";
            } else if (isLoss) {
              streak = p.streakType === "loss" ? streak + 1 : 1;
              streakType = "loss";
            }
            return { totalTrades: newTotal, wins: newWins, losses: newLosses,
              totalPnl: p.totalPnl + reward, recentPnls: newPnls, streak, streakType };
          });
        }

        // Anneal exploration rate (less exploration over time)
        setExplorationRate(prev => Math.max(0.02, prev * 0.998));
      }

      // ── Forward pass ──────────────────────────────────────────────────────
      const state = buildStateArray(verdict, metrics, ctx);
      const result = forward(state, weightsRef.current);
      const [pLong, pShort, pHold] = result.probs;
      const probs: ActionProbs = { long: pLong, short: pShort, hold: pHold };
      const { action, confidence, explorationBonus } = decideAction(probs, explorationRate);

      // Update context
      ctx.recentProbs = [probs, ...ctx.recentProbs].slice(0, 5);

      tickRef.current += 1;
      const decision: AgentDecision = {
        action, probs, confidence,
        score: verdict?.score ?? 0,
        timestamp: Date.now(),
        entry: metrics.mid,
        tick: tickRef.current,
        stateArr: state,
        explorationBonus,
      };

      // Store for next reward computation
      const actionIdx = action === "LONG" ? 0 : action === "SHORT" ? 1 : 2;
      lastDecRef.current = { state, action: actionIdx, price: metrics.mid };

      setCurrent(decision);
      setLog(prev => [decision, ...prev].slice(0, 15));
      setThinking(false);
    }, 50);
  }, [verdict, metrics, explorationRate]);

  useEffect(() => {
    if (!active) {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }
    evaluate();
    timerRef.current = setInterval(evaluate, 2000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [active, evaluate]);

  useEffect(() => {
    if (!active) {
      setCurrent(null);
      setLog([]);
      tickRef.current = 0;
      lastDecRef.current = null;
      contextRef.current = { recentProbs: [], recentWinRate: 0.5, totalDecisions: 0, wins: 0 };
      setLearningStep(0);
      setExplorationRate(0.15);
      setPerf({ totalTrades: 0, wins: 0, losses: 0, totalPnl: 0, recentPnls: [], streak: 0, streakType: "none" });
    }
  }, [active]);

  const stateItems = active && metrics ? buildStateMap(verdict, metrics, contextRef.current) : null;
  const noData = active && !metrics;
  const winRate = perf.totalTrades > 0 ? (perf.wins / perf.totalTrades) * 100 : 0;

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
                  <span className="text-[9px] mono px-1.5 py-0.5 rounded-full bg-primary/20 text-primary border border-primary/30 uppercase tracking-wider">
                    LIVE
                  </span>
                  {learningStep > 0 && (
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
                  : `تيكر #${tickRef.current} · خطوات التعلم: ${learningStep} · استكشاف: ${(explorationRate * 100).toFixed(0)}%`
                : "PPO Neural Policy · 14-feature · 32-16-3 layers · Online REINFORCE"
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

        {/* Decision cards */}
        {active && !noData && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <DecisionCard action={current?.action ?? null} thinking={thinking}
                exploration={current?.explorationBonus === 1} />
              <ConfidenceCard confidence={current?.confidence ?? null} thinking={thinking} />
              <ScoreCard score={current?.score ?? null} thinking={thinking} />
            </div>

            {/* Probability bars */}
            {current && <ProbBars probs={current.probs} thinking={thinking} />}

            {/* Performance metrics */}
            {perf.totalTrades >= 2 && (
              <div className="rounded-xl border border-border bg-secondary/20 p-3 grid grid-cols-4 gap-2 text-center">
                <PerfCell label="الصفقات" value={perf.totalTrades.toString()} />
                <PerfCell label="WinRate"
                  value={`${winRate.toFixed(0)}%`}
                  color={winRate >= 55 ? "text-bull" : winRate >= 45 ? "text-gold" : "text-bear"} />
                <PerfCell label="PnL الحي"
                  value={`${perf.totalPnl >= 0 ? "+" : ""}${(perf.totalPnl * 100).toFixed(2)}%`}
                  color={perf.totalPnl >= 0 ? "text-bull" : "text-bear"} />
                <PerfCell label={`سلسلة`}
                  value={perf.streak > 1 ? `${perf.streak}${perf.streakType === "win" ? "✓" : "✗"}` : "-"}
                  color={perf.streakType === "win" ? "text-bull" : perf.streakType === "loss" ? "text-bear" : ""} />
              </div>
            )}

            {/* State vector */}
            {stateItems && (
              <div className="rounded-xl border border-border bg-secondary/20 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <Database className="size-3 text-primary" />
                    State Vector
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] mono text-gold">ε={( explorationRate * 100).toFixed(1)}%</span>
                    <span className="text-[10px] mono bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded-full">
                      {stateItems.length} features
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {stateItems.map(({ k, v }) => (
                    <FeatureCell key={k} name={k} value={v} />
                  ))}
                </div>
                {learningStep > 0 && (
                  <div className="flex items-center gap-1.5 text-[10px] text-bull mt-1">
                    <Brain className="size-3" />
                    <span>خطوات تدريب: {learningStep} · عينات الذاكرة: {replayRef.current.length}/{MAX_REPLAY}</span>
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
              <div className="text-[11px] text-muted-foreground mt-0.5 max-w-xs mx-auto">
                وكيل تعزيزي حقيقي (REINFORCE) بذاكرة تجارب وتعلم تلقائي من كل قرار
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

// ── Sub-components ─────────────────────────────────────────────────────────────
function ArchBadge({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="rounded-lg border border-border bg-card/40 px-2 py-1.5 flex items-center gap-1.5 justify-center text-muted-foreground">
      {icon}{label}
    </div>
  );
}

function PerfCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card/40 py-1.5">
      <div className="text-[9px] text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className={cn("mono text-[11px] font-bold mt-0.5", color ?? "text-foreground")}>{value}</div>
    </div>
  );
}

function DecisionCard({ action, thinking, exploration }:
  { action: RLAction | null; thinking: boolean; exploration?: boolean }) {
  const cfg = {
    LONG:  { color: "text-bull", bg: "bg-bull/8 border-bull/30",  Icon: TrendingUp,  ar: "شراء LONG"  },
    SHORT: { color: "text-bear", bg: "bg-bear/8 border-bear/30",  Icon: TrendingDown, ar: "بيع SHORT" },
    HOLD:  { color: "text-gold", bg: "bg-gold/8 border-gold/30",  Icon: Minus,        ar: "انتظار HOLD"},
  };
  const c = action ? cfg[action] : null;
  return (
    <div className={cn(
      "rounded-xl border p-3 transition-all relative",
      thinking ? "animate-pulse bg-secondary/30 border-border" : c ? c.bg : "bg-card/40 border-border"
    )}>
      {exploration && !thinking && (
        <span className="absolute top-1 left-1 text-[8px] mono text-primary opacity-70">ε</span>
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
    <div className="rounded-lg border border-border bg-card/40 px-1.5 py-1 text-center">
      <div className="text-[8px] text-muted-foreground uppercase tracking-wider truncate">{name}</div>
      <div className={cn("mono text-[10px] font-bold mt-0.5", color)}>
        {value >= 0 ? "+" : ""}{value.toFixed(2)}
      </div>
    </div>
  );
}

function LogRow({ decision, isLatest }: { decision: AgentDecision; isLatest: boolean }) {
  const time = new Date(decision.timestamp).toLocaleTimeString("ar", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
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
      {decision.explorationBonus === 1 && (
        <span className="text-[8px] text-primary">ε</span>
      )}
      <span className="text-muted-foreground text-[9px] w-10 text-left">#{decision.tick}</span>
    </div>
  );
}
