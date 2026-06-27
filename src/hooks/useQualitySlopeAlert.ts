import { useEffect, useRef } from "react";
import { useSession, type QualitySample } from "@/lib/session-store";

const EMPTY_HISTORY: QualitySample[] = [];

/** Slope per minute on score over recent samples (mins). */
function slopePerMin(samples: { t: number; score: number }[]): number {
  if (samples.length < 5) return 0;
  const n = samples.length;
  const t0 = samples[0].t;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const s of samples) {
    const x = (s.t - t0) / 60000;
    sx += x; sy += s.score; sxx += x * x; sxy += x * s.score;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (n * sxy - sx * sy) / denom;
}

/**
 * Fires ONE alert when degradation slope persists for confirmSec seconds
 * — ignores instantaneous spikes.
 */
export function useQualitySlopeAlert(symbol: string) {
  const cfg = useSession((s) => s.qualityAlert);
  const history = useSession((s) => s.qualityHistory[symbol] ?? EMPTY_HISTORY);
  const sinceRef = useRef<number | null>(null);
  const lastFiredRef = useRef<number>(0);
  const pushAlertRef = useRef(useSession.getState().pushAlert);
  useEffect(() => {
    pushAlertRef.current = useSession.getState().pushAlert;
  });

  useEffect(() => {
    if (!cfg.enabled || history.length < 15) {
      sinceRef.current = null;
      return;
    }
    const win = history.filter((s) => Date.now() - s.t < 10 * 60_000);
    const slope = slopePerMin(win);
    const recentAvg =
      win.slice(-Math.min(win.length, 60))
         .reduce((a, s) => a + s.score, 0) /
      Math.max(1, Math.min(win.length, 60));

    const triggering = slope <= -cfg.slopePerMin && recentAvg < cfg.scoreFloor;

    if (triggering) {
      const now = Date.now();
      if (sinceRef.current == null) sinceRef.current = now;
      const sustainedSec = (now - sinceRef.current) / 1000;
      const cooldownOk = now - lastFiredRef.current >= cfg.cooldownSec * 1000;
      if (sustainedSec >= cfg.confirmSec && cooldownOk) {
        lastFiredRef.current = now;
        pushAlertRef.current({
          symbol,
          type: "imbalance", // reuse channel
          severity: recentAvg < cfg.scoreFloor - 15 ? "critical" : "warn",
          title: "تدهور مستمر في جودة البيانات",
          detail: `ميل ${slope.toFixed(2)}/د · متوسط حديث ${recentAvg.toFixed(0)}/100 · مؤكَّد لأكثر من ${cfg.confirmSec} ث`,
        });
      }
    } else {
      sinceRef.current = null;
    }
  }, [history, cfg, symbol]);
}
