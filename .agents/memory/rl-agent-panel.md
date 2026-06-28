---
name: RL Agent Panel pattern
description: Architecture of RLAgentPanel — now a proper online-learning REINFORCE agent.
---

# RLAgentPanel Architecture

## Current architecture (v2)
- **Network**: 14 inputs → 32 hidden (ReLU) → 16 hidden (ReLU) → 3 outputs (Softmax)
- **14 features**: score, conf, imbal, proxPx, micro, mom, volDir, rsi, sprd, wallImb, atrNorm, entropy, recentWinRate, momentumStrength
- **Learning**: REINFORCE policy gradient with entropy bonus (ENTROPY_COEFF=0.08)
- **Experience replay**: 500-slot buffer; mini-batch of 24 sampled each update step
- **Exploration**: ε-greedy annealing from 15% → 2% (ε *= 0.998 per step)
- **Online reward**: computed from next mid-price change (LONG: priceDelta×10, SHORT: -priceDelta×10, HOLD: stillness reward)

## Props
`verdict: InstitutionalVerdictV2 | null, metrics: BookMetrics | null`

## Key refs
- `weightsRef`: mutable Weights object (W1/b1/W2/b2/W3/b3) updated in-place
- `replayRef`: Experience[] buffer
- `lastDecRef`: previous (state, action, price) for reward computation

## Why self-contained
All learning state is local to the component. No global store needed. Reset on deactivate.
