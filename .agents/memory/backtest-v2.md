---
name: Backtest engine v2
description: How the backtest scoring was unified with the live engine, and what new metrics were added.
---

# Backtest Engine v2

## The rule
`signalAt()` in `src/lib/backtest.ts` must use **the same weights as `institutionalScoreV2`** — never a different simplified formula.

**Why:** The original `signalAt` used `momentum*0.45 + volumeTrend*0.15 + ...` which was completely different from the live engine's weights (0.25/0.20/0.15/0.15/0.15/0.10). This made backtest scores uncorrelated with live scores → "fake data" problem.

## How to apply
- `computeSyntheticBook()` reconstructs bid/ask pressure from OHLCV candle microstructure
- `signalAtV2()` applies the IDENTICAL weighted sum: bookImbalance×0.25 + wallPressure×0.20 + momentum×0.15 + rsiPenalty×0.15 + volumeTrend×0.15 + microDrift×0.10
- Entry on next bar open (zero look-ahead bias), slippage applied
- New metrics: sharpeRatio, sortinoRatio, calmarRatio, avgHoldBars, maxConsecWins, maxConsecLosses, longWinRate, shortWinRate, scoreDistribution

## Synthetic book key insight
- Bullish candle → more buying pressure → positive bookImbalance proxy
- Liquidity zones from `detectLiquidityZones()` serve as wall proxies
- SpreadProxy from ATR/price ratio
