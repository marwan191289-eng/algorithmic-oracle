import numpy as np
from typing import Dict, List, Optional
from scipy.stats import zscore

class InstitutionalEngine:
    def __init__(self, ema_alpha=0.3, z_threshold=2.5, quality_threshold=60):
        self.ema_alpha = ema_alpha
        self.z_threshold = z_threshold
        self.quality_threshold = quality_threshold
        self.prev_smoothed = None
        self.price_history = []
        self.vol_history = []
        self.walls_history = []
        self.quality = 100.0

    def compute_microprice(self, orderbook: Dict) -> float:
        best_bid = orderbook['bids'][0]['price']
        best_ask = orderbook['asks'][0]['price']
        bid_size = orderbook['bids'][0]['qty']
        ask_size = orderbook['asks'][0]['qty']
        return (best_ask * bid_size + best_bid * ask_size) / (bid_size + ask_size + 1e-9)

    def compute_imbalance(self, orderbook: Dict, near_pct=0.01) -> float:
        mid = orderbook['mid']
        bid_usd = 0.0
        ask_usd = 0.0
        for b in orderbook['bids']:
            if (mid - b['price']) / mid <= near_pct:
                weight = 1.0 / (abs(mid - b['price']) / mid + 0.0001)
                bid_usd += b['qty'] * b['price'] * weight
        for a in orderbook['asks']:
            if (a['price'] - mid) / mid <= near_pct:
                weight = 1.0 / (abs(a['price'] - mid) / mid + 0.0001)
                ask_usd += a['qty'] * a['price'] * weight
        imbalance = (bid_usd - ask_usd) / (bid_usd + ask_usd + 1e-9)
        return np.clip(imbalance, -1, 1)

    def detect_walls(self, orderbook_snapshots: List[Dict]) -> List[Dict]:
        # Assume orderbook_snapshots is a list of orderbook dicts over time
        # Extract USD quantities per price level over time for z-score calculation
        bids_usd = np.array([[level['qty'] * level['price'] for level in snap['bids']] for snap in orderbook_snapshots])
        asks_usd = np.array([[level['qty'] * level['price'] for level in snap['asks']] for snap in orderbook_snapshots])
        combined = np.hstack((bids_usd, asks_usd))
        current = combined[-1]
        means = np.mean(combined, axis=0)
        stds = np.std(combined, axis=0) + 1e-9
        zs = (current - means) / stds
        walls = []
        for idx, z in enumerate(zs):
            if z >= self.z_threshold:
                side = 'bid' if idx < bids_usd.shape[1] else 'ask'
                price = orderbook_snapshots[-1]['bids'][idx]['price'] if side == 'bid' else orderbook_snapshots[-1]['asks'][idx - bids_usd.shape[1]]['price']
                walls.append({'price': price, 'zscore': z, 'side': side})
        return walls

    def compute_rsi(self, closes: List[float], period=14) -> float:
        if len(closes) < period + 1:
            return 50.0
        deltas = np.diff(closes)
        ups = np.sum(deltas[deltas > 0])
        downs = -np.sum(deltas[deltas < 0])
        if downs == 0:
            return 100.0
        rs = ups / downs
        rsi = 100 - (100 / (1 + rs))
        return rsi

    def compute_atr(self, candles: List[Dict], period=14) -> float:
        if len(candles) < period + 1:
            return 0.0
        trs = []
        for i in range(1, len(candles)):
            high = candles[i]['high']
            low = candles[i]['low']
            prev_close = candles[i - 1]['close']
            tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
            trs.append(tr)
        return np.mean(trs[-period:])

    def compute_momentum(self, volumes: List[float]) -> float:
        if len(volumes) < 2:
            return 0.0
        x = np.arange(len(volumes))
        y = np.log(np.array(volumes) + 1e-9)
        slope = np.polyfit(x, y, 1)[0]
        return np.tanh(slope)

    def compute_confidence(self, components: Dict[str, float]) -> int:
        signs = [np.sign(v) for v in components.values()]
        agreement = abs(sum(signs)) / len(signs)
        quality_factor = min(1.0, self.quality / 100.0)
        confidence = int(round(100 * (0.6 * agreement + 0.4 * quality_factor)))
        return confidence

    def compute_score(self, orderbook: Dict, trades: List[Dict], candles: List[Dict], orderbook_history: List[Dict]) -> Optional[Dict]:
        if self.quality < self.quality_threshold:
            return None

        microprice = self.compute_microprice(orderbook)
        imbalance = self.compute_imbalance(orderbook)
        volumes = [t['size'] for t in trades]
        momentum = self.compute_momentum(volumes)
        closes = [c['close'] for c in candles]
        rsi = self.compute_rsi(closes)
        atr = self.compute_atr(candles)
        walls = self.detect_walls(orderbook_history)

        walls_pressure = 0.0
        mid = orderbook['mid']
        for w in walls:
            dist = abs(w['price'] - mid) / mid
            weight = 1.0 / (dist + 0.0001)
            walls_pressure += w['zscore'] * weight
        walls_pressure = np.tanh(walls_pressure / (1 + len(walls)))

        rsi_damping = 1.0
        if rsi > 70:
            rsi_damping = max(0.0, 1.0 - (rsi - 70) / 30)
        elif rsi < 30:
            rsi_damping = max(0.0, 1.0 - (30 - rsi) / 30)

        micro_drift = (microprice - mid) / mid
        vol_dir = 0.0
        if len(self.vol_history) > 100:
            recent_vol = np.sum(volumes[-10:])
            mean_vol = np.mean(self.vol_history[-100:])
            std_vol = np.std(self.vol_history[-100:]) + 1e-9
            vol_dir = np.tanh((recent_vol - mean_vol) / std_vol)

        self.price_history.append(mid)
        self.vol_history.extend(volumes)
        if len(self.price_history) > 10000:
            self.price_history.pop(0)
        if len(self.vol_history) > 20000:
            self.vol_history = self.vol_history[-20000:]

        components = {
            'imbalance': np.clip(imbalance, -1, 1),
            'wallsPressure': np.clip(walls_pressure, -1, 1),
            'momentum': np.clip(momentum, -1, 1),
            'rsiDamping': np.clip(rsi_damping * 2 - 1, -1, 1),
            'volumeDirection': np.clip(vol_dir, -1, 1),
            'microDrift': np.clip(np.tanh(micro_drift * 100), -1, 1)
        }

        weights = {
            'imbalance': 0.25,
            'wallsPressure': 0.2,
            'momentum': 0.15,
            'rsiDamping': 0.15,
            'volumeDirection': 0.15,
            'microDrift': 0.1
        }

        raw_score = sum(components[k] * weights[k] for k in components)
        scaled_score = int(round(raw_score * 100))

        if self.prev_smoothed is None:
            smoothed_score = scaled_score
        else:
            smoothed_score = int(round(self.ema_alpha * scaled_score + (1 - self.ema_alpha) * self.prev_smoothed))
        self.prev_smoothed = smoothed_score

        confidence = self.compute_confidence(components)

        plan = None
        if atr > 0:
            entry = mid
            stop = entry - 1.5 * atr if smoothed_score > 0 else entry + 1.5 * atr
            tp1 = entry + (1 if smoothed_score > 0 else -1) * 1.0 * atr
            tp2 = entry + (1 if smoothed_score > 0 else -1) * 2.0 * atr
            rr = abs((tp1 - entry) / (entry - stop + 1e-9))
            plan = {'entry': entry, 'stop': stop, 'tp1': tp1, 'tp2': tp2, 'rr': rr}

        return {
            'raw': raw_score,
            'scaled': scaled_score,
            'smoothed': smoothed_score,
            'confidence': confidence,
            'components': components,
            'plan': plan,
            'walls': walls
        }
