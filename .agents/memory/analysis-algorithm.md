---
name: Analysis algorithm architecture
description: Key algorithmic decisions and Python-port patterns in src/lib/analysis.ts
---

## Proximity-weighted imbalance (Python InstitutionalEngine port)
`BookMetrics.proximityImbalance` — weight = `1 / (distPct + 0.0001)` so near-mid orders dominate. Replaces plain `imbalance` (simple USD sum) as the primary input to `institutionalScoreV2`.

## Log-volume momentum (Python InstitutionalEngine.compute_momentum port)
`PriceMetrics.logVolMomentum` — fits a linear regression to `log(volume)` over last 30 candles, then `tanh(slope * 10)`. Combined 50/50 with the standard volumeTrend in the V2 scoring engine.

## Python-aligned weight schema (institutionalScoreV2)
Weights now match the Python reference: imbalance 0.25, wallPressure 0.20, momentum 0.15, rsiDamping 0.15, volumeDirection 0.15, microDrift 0.10.

## Python-aligned confidence formula
`confidence = round(100 * (0.6 * agreementRatio + 0.4 * qualityFactor))` — 60% component agreement + 40% data quality (spreadHealth proxy). Matches Python InstitutionalEngine.compute_confidence exactly.

## ScoreRing SVG component
`src/components/trading/ScoreRing.tsx` — circular SVG arc gauge (r=48, circumference=301.6). Maps score [-100,+100] to dashoffset. Color transitions from #ff4d6d (bear) through #ffb020 (neutral) to #17c784 (bull).
