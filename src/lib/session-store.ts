// ════════════════════════════════════════════════════════════════════════
//  Session store — wall settings, alerts, data quality, last snapshot
//  Single source of truth shared across views (dashboard + report).
// ════════════════════════════════════════════════════════════════════════
import { create } from "zustand";
import type {
  BookMetrics,
  InstitutionalVerdict,
  LiquidityZone,
  PriceMetrics,
  WallReport,
} from "./analysis";
import type { Interval, Ticker } from "./binance";
import type { BacktestResult } from "./backtest";

// ─── Live signal log (for Live-vs-Backtest comparison) ───────────────────
export interface LiveSignalSample {
  t: number;
  symbol: string;
  interval: string;
  score: number;
  side: "long" | "short" | "none";
  confidence: number;
  mid: number;
}
export const LIVE_LOG_MAX = 1000;

// ─── Quality alert config (slope-based, with confirmation duration) ──────
export interface QualityAlertConfig {
  enabled: boolean;
  slopePerMin: number;     // trigger when slope ≤ −this for confirmSec
  scoreFloor: number;      // require recent avg below this
  confirmSec: number;      // sustained duration before notifying
  cooldownSec: number;
}
export const DEFAULT_QUALITY_ALERT: QualityAlertConfig = {
  enabled: true,
  slopePerMin: 1.5,
  scoreFloor: 70,
  confirmSec: 30,
  cooldownSec: 120,
};

// ─── Wall detection settings ─────────────────────────────────────────────
export type WallMethod = "zscore" | "percentile" | "absolute";

export interface WallSettings {
  depth: number;          // number of book levels scanned per side
  zThreshold: number;     // for zscore method
  percentile: number;     // for percentile method (e.g. 95)
  absoluteUsd: number;    // for absolute method (USD notional cutoff)
  method: WallMethod;
  maxPerSide: number;
}

export const DEFAULT_WALL_SETTINGS: WallSettings = {
  depth: 200,
  zThreshold: 2.5,
  percentile: 95,
  absoluteUsd: 250_000,
  method: "zscore",
  maxPerSide: 8,
};

// ─── Alert settings ──────────────────────────────────────────────────────
export interface AlertSettings {
  enabled: boolean;
  symbols: string[];               // which pairs trigger alerts
  wallUsdThreshold: number;        // notify when a wall > this USD
  imbalanceThreshold: number;      // 0..1 — abs(book imbalance)
  stopHuntProbThreshold: number;   // 0..100 — liquidity zone probability
  cooldownSec: number;             // anti-spam per (symbol+type+price-bucket)
  sound: boolean;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  enabled: true,
  symbols: [],                     // [] = all
  wallUsdThreshold: 500_000,
  imbalanceThreshold: 0.45,
  stopHuntProbThreshold: 70,
  cooldownSec: 60,
  sound: false,
};

// ─── Data quality ────────────────────────────────────────────────────────
export interface QualityMetrics {
  symbol: string;
  connected: boolean;
  lastMsgAt: number;           // epoch ms
  latencyMs: number;           // rolling avg of (now − server event time)
  updateRateHz: number;        // msgs / sec rolling 5s
  disconnects: number;
  totalMessages: number;
  score: number;               // 0..100
  level: "excellent" | "good" | "degraded" | "poor";
}

export interface QualityState {
  blockOnLowQuality: boolean;
  minAcceptableScore: number;  // 0..100
  bySymbol: Record<string, QualityMetrics>;
}

// ─── Quality history (rolling 60 min, 1-sample-per-second) ───────────────
export interface QualitySample {
  t: number;        // epoch ms
  score: number;    // 0..100
  latencyMs: number;
  updateRateHz: number;
  connected: boolean;
}

export const QUALITY_HISTORY_MAX = 3600; // ~60 min @1Hz

// ─── Alerts ──────────────────────────────────────────────────────────────
export interface AlertItem {
  id: string;
  time: number;
  symbol: string;
  type: "wall" | "imbalance" | "stop_hunt";
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  price?: number;
}

// ─── Last snapshot (for PDF report) ──────────────────────────────────────
export interface SessionSnapshot {
  symbol: string;
  interval: Interval;
  capturedAt: number;
  mid: number;
  ticker: Ticker | null;
  metrics: BookMetrics;
  walls: WallReport;
  zones: LiquidityZone[];
  priceMetrics: PriceMetrics;
  verdict: InstitutionalVerdict;
  wallSettings: WallSettings;
  quality: QualityMetrics | null;
  chartImage: string | null; // dataURL
}

// ─── Store ───────────────────────────────────────────────────────────────
interface State {
  wallSettings: WallSettings;
  alertSettings: AlertSettings;
  quality: QualityState;
  qualityHistory: Record<string, QualitySample[]>;
  qualityAlert: QualityAlertConfig;
  alerts: AlertItem[];
  unreadAlerts: number;
  snapshot: SessionSnapshot | null;
  lastAlertKey: Record<string, number>;
  liveSignalLog: Record<string, LiveSignalSample[]>;
  lastBacktest: BacktestResult | null;
  previousBacktest: BacktestResult | null;

  setWallSettings: (s: Partial<WallSettings>) => void;
  resetWallSettings: () => void;
  setAlertSettings: (s: Partial<AlertSettings>) => void;
  setQualityAlert: (s: Partial<QualityAlertConfig>) => void;
  setBlockOnLowQuality: (v: boolean) => void;
  setMinAcceptableScore: (v: number) => void;
  updateQuality: (symbol: string, patch: Partial<QualityMetrics>) => void;
  pushQualitySample: (symbol: string) => void;
  pushAlert: (a: Omit<AlertItem, "id" | "time">) => void;
  clearAlerts: () => void;
  markAlertsRead: () => void;
  saveSnapshot: (s: SessionSnapshot) => void;
  pushLiveSignal: (s: LiveSignalSample) => void;
  saveBacktest: (r: BacktestResult) => void;
}

export const useSession = create<State>((set, get) => ({
  wallSettings: { ...DEFAULT_WALL_SETTINGS },
  alertSettings: { ...DEFAULT_ALERT_SETTINGS },
  quality: { blockOnLowQuality: false, minAcceptableScore: 55, bySymbol: {} },
  qualityAlert: { ...DEFAULT_QUALITY_ALERT },
  alerts: [],
  unreadAlerts: 0,
  snapshot: null,
  lastAlertKey: {},
  qualityHistory: {},
  liveSignalLog: {},
  lastBacktest: null,
  previousBacktest: null,

  setWallSettings: (s) =>
    set((st) => ({ wallSettings: { ...st.wallSettings, ...s } })),
  resetWallSettings: () => set({ wallSettings: { ...DEFAULT_WALL_SETTINGS } }),
  setAlertSettings: (s) =>
    set((st) => ({ alertSettings: { ...st.alertSettings, ...s } })),
  setBlockOnLowQuality: (v) =>
    set((st) => ({ quality: { ...st.quality, blockOnLowQuality: v } })),
  setMinAcceptableScore: (v) =>
    set((st) => ({ quality: { ...st.quality, minAcceptableScore: v } })),

  updateQuality: (symbol, patch) =>
    set((st) => {
      const cur =
        st.quality.bySymbol[symbol] ??
        ({
          symbol,
          connected: false,
          lastMsgAt: 0,
          latencyMs: 0,
          updateRateHz: 0,
          disconnects: 0,
          totalMessages: 0,
          score: 0,
          level: "poor",
        } as QualityMetrics);
      const merged: QualityMetrics = { ...cur, ...patch };
      // recompute score / level
      const latPenalty = Math.min(50, merged.latencyMs / 20); // 1000ms => 50
      const ratePenalty = merged.updateRateHz < 2 ? 30 : merged.updateRateHz < 5 ? 10 : 0;
      const connPenalty = merged.connected ? 0 : 40;
      const stale = Date.now() - merged.lastMsgAt;
      const stalePenalty = !merged.lastMsgAt ? 30 : stale > 5000 ? 30 : stale > 2000 ? 12 : 0;
      const raw = 100 - latPenalty - ratePenalty - connPenalty - stalePenalty;
      merged.score = Math.max(0, Math.min(100, Math.round(raw)));
      merged.level =
        merged.score >= 85
          ? "excellent"
          : merged.score >= 65
          ? "good"
          : merged.score >= 40
          ? "degraded"
          : "poor";
      return {
        quality: {
          ...st.quality,
          bySymbol: { ...st.quality.bySymbol, [symbol]: merged },
        },
      };
    }),

  pushQualitySample: (symbol) =>
    set((st) => {
      const q = st.quality.bySymbol[symbol];
      if (!q) return {};
      const sample: QualitySample = {
        t: Date.now(),
        score: q.score,
        latencyMs: q.latencyMs,
        updateRateHz: q.updateRateHz,
        connected: q.connected,
      };
      const prev = st.qualityHistory[symbol] ?? [];
      const next = [...prev, sample];
      if (next.length > QUALITY_HISTORY_MAX) next.splice(0, next.length - QUALITY_HISTORY_MAX);
      return { qualityHistory: { ...st.qualityHistory, [symbol]: next } };
    }),


  pushAlert: (a) => {
    const st = get();
    if (!st.alertSettings.enabled) return;
    if (
      st.alertSettings.symbols.length > 0 &&
      !st.alertSettings.symbols.includes(a.symbol)
    )
      return;
    const bucket = a.price ? Math.round(a.price * 100) / 100 : 0;
    const key = `${a.symbol}:${a.type}:${bucket}`;
    const last = st.lastAlertKey[key] ?? 0;
    const now = Date.now();
    if (now - last < st.alertSettings.cooldownSec * 1000) return;

    const item: AlertItem = {
      id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
      time: now,
      ...a,
    };
    set({
      alerts: [item, ...st.alerts].slice(0, 80),
      unreadAlerts: st.unreadAlerts + 1,
      lastAlertKey: { ...st.lastAlertKey, [key]: now },
    });
    if (st.alertSettings.sound && typeof window !== "undefined") {
      try {
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = a.severity === "critical" ? 880 : 660;
        g.gain.value = 0.05;
        o.connect(g).connect(ctx.destination);
        o.start();
        o.stop(ctx.currentTime + 0.15);
      } catch {}
    }
  },
  clearAlerts: () => set({ alerts: [], unreadAlerts: 0, lastAlertKey: {} }),
  markAlertsRead: () => set({ unreadAlerts: 0 }),
  saveSnapshot: (s) => set({ snapshot: s }),
  setQualityAlert: (s) =>
    set((st) => ({ qualityAlert: { ...st.qualityAlert, ...s } })),
  pushLiveSignal: (s) =>
    set((st) => {
      const prev = st.liveSignalLog[s.symbol] ?? [];
      const next = [...prev, s];
      if (next.length > LIVE_LOG_MAX) next.splice(0, next.length - LIVE_LOG_MAX);
      return { liveSignalLog: { ...st.liveSignalLog, [s.symbol]: next } };
    }),
  saveBacktest: (r) =>
    set((st) => ({ previousBacktest: st.lastBacktest, lastBacktest: r })),
}));
