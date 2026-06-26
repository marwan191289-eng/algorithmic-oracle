import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  SYMBOLS,
  TIMEFRAMES,
  type Interval,
  fetchKlines,
  fmtPct,
  fmtPrice,
  fmtUsd,
} from "@/lib/binance";
import { useLiveDepth, useLiveTicker } from "@/hooks/useBinance";
import {
  computeBookMetrics,
  computePriceMetrics,
  detectLiquidityZones,
  detectWalls,
  institutionalScoreV2,
} from "@/lib/analysis";
import { SymbolBar } from "@/components/trading/SymbolBar";
import { OrderBookHeatmap } from "@/components/trading/OrderBookHeatmap";
import { WallsPanel } from "@/components/trading/WallsPanel";
import { LiquidityZonesPanel } from "@/components/trading/LiquidityZonesPanel";
import { InstitutionalPanel } from "@/components/trading/InstitutionalPanel";
import { CandleChart } from "@/components/trading/CandleChart";
import { DataQualityBar, QualityBlockNotice } from "@/components/trading/DataQualityBar";
import { QualityHistoryChart, useQualityBlockDecision } from "@/components/trading/QualityHistoryChart";
import { WallSettingsPanel } from "@/components/trading/WallSettingsPanel";
import { AlertSettingsPanel } from "@/components/trading/AlertSettingsPanel";
import { AlertsCenter } from "@/components/trading/AlertsCenter";
import { useSession } from "@/lib/session-store";
import { cn } from "@/lib/utils";
import { Radio, Zap, BookOpen, Crosshair, LineChart, FileText, Sliders, FlaskConical, AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "WhaleEye — منصة التحليل المؤسساتي للعملات الرقمية" },
      {
        name: "description",
        content:
          "خوارزمية تحليل مؤسساتية لدفتر الأوامر، الجدران السعرية، ومناطق صيد الستوبات لأهم العملات الرقمية على Binance.",
      },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const [symbol, setSymbol] = useState<string>(SYMBOLS[0]);
  const [interval, setInterval] = useState<Interval>("1h");
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="min-h-screen text-foreground scan-line">
      <Header />
      <main className="max-w-[1600px] mx-auto px-4 md:px-6 pb-12 space-y-5">
        <SymbolBar active={symbol} onSelect={setSymbol} />

        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.value}
                onClick={() => setInterval(tf.value)}
                className={cn(
                  "text-[11px] px-2.5 py-1 rounded-md mono font-semibold border transition",
                  interval === tf.value
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:text-foreground hover:border-accent"
                )}
              >
                {tf.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowSettings((v) => !v)}
            className={cn(
              "text-[11px] mono px-2.5 py-1.5 rounded-md border flex items-center gap-1.5 transition",
              showSettings
                ? "border-primary/50 bg-primary/15 text-primary"
                : "border-border bg-card/50 text-muted-foreground hover:text-foreground"
            )}
          >
            <Sliders className="size-3.5" /> الإعدادات
          </button>
        </div>

        <DataQualityBar symbol={symbol} />

        {showSettings && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <WallSettingsPanel />
            <AlertSettingsPanel />
          </div>
        )}

        <SymbolView symbol={symbol} interval={interval} onInterval={setInterval} />
      </main>
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/70 backdrop-blur-xl">
      <div className="max-w-[1600px] mx-auto px-4 md:px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="size-10 rounded-xl bg-gradient-to-br from-primary to-whale flex items-center justify-center glow-neon">
            <Zap className="size-5 text-primary-foreground" />
          </div>
          <div>
            <div className="font-extrabold text-lg leading-tight tracking-tight">
              WhaleEye <span className="text-primary">/ عين الحوت</span>
            </div>
            <div className="text-[11px] text-muted-foreground mono">
              Institutional Order-Flow Engine · Binance Live
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-2 text-[11px] mono text-muted-foreground">
            <Radio className="size-3 text-bull ticker-pulse" />
            البث المباشر مفعل
          </div>
          <Link
            to="/report"
            className="text-[11px] mono px-2.5 py-1.5 rounded-md border border-border bg-card/60 hover:bg-card flex items-center gap-1.5"
          >
            <FileText className="size-3.5" /> التقرير
          </Link>
          <div className="relative">
            <AlertsCenter />
          </div>
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border mt-8">
      <div className="max-w-[1600px] mx-auto px-4 md:px-6 py-6 text-center text-[11px] text-muted-foreground">
        البيانات من Binance Public WebSocket · هذه أداة تحليلية ولا تُعد توصية
        استثمارية · إدارة المخاطر مسؤوليتك
      </div>
    </footer>
  );
}

function SymbolView({
  symbol,
  interval,
  onInterval,
}: {
  symbol: string;
  interval: Interval;
  onInterval: (i: Interval) => void;
}) {
  const { book, connected } = useLiveDepth(symbol);
  const { ticker, flash } = useLiveTicker(symbol);

  const wallSettings = useSession((s) => s.wallSettings);
  const blockOnLow = useSession((s) => s.quality.blockOnLowQuality);
  const minScore = useSession((s) => s.quality.minAcceptableScore);
  const quality = useSession((s) => s.quality.bySymbol[symbol]);
  const alertSettings = useSession((s) => s.alertSettings);
  const pushAlert = useSession((s) => s.pushAlert);
  const saveSnapshot = useSession((s) => s.saveSnapshot);

  const chartContainerRef = useRef<HTMLDivElement>(null);

  const { data: klines } = useQuery({
    queryKey: ["klines", symbol, interval],
    queryFn: () => fetchKlines(symbol, interval, 200),
    refetchInterval: 15000,
  });

  const metrics = useMemo(() => (book ? computeBookMetrics(book, 50) : null), [book]);
  const walls = useMemo(
    () =>
      book && metrics
        ? detectWalls(book, metrics.mid, {
            depth: wallSettings.depth,
            zThreshold: wallSettings.zThreshold,
            percentile: wallSettings.percentile,
            absoluteUsd: wallSettings.absoluteUsd,
            method: wallSettings.method,
            maxPerSide: wallSettings.maxPerSide,
          })
        : null,
    [book, metrics, wallSettings]
  );
  const priceMetrics = useMemo(
    () => (klines ? computePriceMetrics(klines) : null),
    [klines]
  );
  const zones = useMemo(
    () => (klines && metrics ? detectLiquidityZones(klines, metrics.mid) : []),
    [klines, metrics]
  );
  const prevScoreRef = useRef<number | undefined>(undefined);
  const verdict = useMemo(() => {
    if (!metrics || !walls || !priceMetrics || !klines) return null;
    const v = institutionalScoreV2(metrics, walls, priceMetrics, klines, {
      prevScore: prevScoreRef.current,
      emaAlpha: 0.3,
    });
    prevScoreRef.current = v.score;
    return v;
  }, [metrics, walls, priceMetrics, klines]);

  // ─── Alerts engine ────────────────────────────────────────────────────
  useEffect(() => {
    if (!walls || !metrics) return;
    const big = [...walls.bidWalls, ...walls.askWalls]
      .filter((w) => w.usd >= alertSettings.wallUsdThreshold)
      .sort((a, b) => b.usd - a.usd)[0];
    if (big) {
      pushAlert({
        symbol,
        type: "wall",
        severity: big.usd > alertSettings.wallUsdThreshold * 3 ? "critical" : "warn",
        title: `جدار ${big.side === "bid" ? "شراء قوي" : "بيع قوي"}`,
        detail: `سعر ${fmtPrice(big.price)} · ${fmtUsd(big.usd)} · ${big.distancePct.toFixed(2)}% من السعر`,
        price: big.price,
      });
    }
    if (Math.abs(metrics.imbalance) >= alertSettings.imbalanceThreshold) {
      pushAlert({
        symbol,
        type: "imbalance",
        severity: Math.abs(metrics.imbalance) > 0.7 ? "critical" : "warn",
        title: `اختلال دفتر ${metrics.imbalance > 0 ? "شرائي" : "بيعي"}`,
        detail: `${(metrics.imbalance * 100).toFixed(1)}% · شراء ${fmtUsd(metrics.bidUsd)} / بيع ${fmtUsd(metrics.askUsd)}`,
        price: metrics.mid,
      });
    }
  }, [walls, metrics, alertSettings.wallUsdThreshold, alertSettings.imbalanceThreshold, symbol, pushAlert]);

  useEffect(() => {
    if (!zones.length) return;
    for (const z of zones) {
      const prob = (z as any).probability ?? (z as any).strength ?? 0;
      const p = typeof prob === "number" && prob <= 1 ? prob * 100 : prob;
      if (p >= alertSettings.stopHuntProbThreshold) {
        pushAlert({
          symbol,
          type: "stop_hunt",
          severity: p >= 85 ? "critical" : "warn",
          title: `منطقة استهداف ستوبات`,
          detail: `${(z as any).type ?? "zone"} · ${fmtPrice((z as any).price ?? (z as any).level ?? 0)} · احتمالية ${p.toFixed(0)}%`,
          price: (z as any).price ?? (z as any).level,
        });
      }
    }
  }, [zones, alertSettings.stopHuntProbThreshold, symbol, pushAlert]);

  // ─── Auto-save snapshot for PDF report ────────────────────────────────
  useEffect(() => {
    if (!metrics || !walls || !priceMetrics || !verdict) return;
    saveSnapshot({
      symbol,
      interval,
      capturedAt: Date.now(),
      mid: metrics.mid,
      ticker,
      metrics,
      walls,
      zones,
      priceMetrics,
      verdict,
      wallSettings,
      quality: quality ?? null,
      chartImage: null,
    });
  }, [symbol, interval, metrics, walls, zones, priceMetrics, verdict, ticker, wallSettings, quality, saveSnapshot]);

  if (!book || !metrics) return <LoadingSkeleton symbol={symbol} />;

  const qScore = quality?.score ?? 100;
  const blocked = blockOnLow && qScore < minScore;

  const up = (ticker?.changePct ?? 0) >= 0;

  return (
    <div className="space-y-5">
      {/* Symbol header card */}
      <div className="rounded-2xl border border-border glass p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <span className="font-extrabold text-3xl tracking-tight">
                {symbol.replace("USDT", "")}
                <span className="text-muted-foreground text-lg">/USDT</span>
              </span>
              <span
                className={cn(
                  "text-[10px] mono uppercase tracking-wider px-2 py-0.5 rounded border",
                  connected
                    ? "border-bull/40 text-bull bg-bull/10"
                    : "border-muted text-muted-foreground"
                )}
              >
                {connected ? "● مباشر" : "○ يتصل..."}
              </span>
              <span className="text-[10px] mono px-2 py-0.5 rounded border border-primary/30 text-primary bg-primary/10">
                {interval.toUpperCase()}
              </span>
            </div>
            <div
              className={cn(
                "mt-1 mono text-5xl font-bold tracking-tight",
                up ? "text-bull" : "text-bear",
                flash === "up" && "flash-up",
                flash === "down" && "flash-down"
              )}
            >
              {ticker ? fmtPrice(ticker.last) : fmtPrice(metrics.mid)}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <Stat label="تغير 24س" value={ticker ? fmtPct(ticker.changePct) : "—"} tone={up ? "bull" : "bear"} />
            <Stat label="أعلى 24س" value={ticker ? fmtPrice(ticker.high) : "—"} />
            <Stat label="أدنى 24س" value={ticker ? fmtPrice(ticker.low) : "—"} />
            <Stat label="حجم 24س" value={ticker ? fmtUsd(ticker.quoteVolume) : "—"} />
          </div>
        </div>
      </div>

      {blocked ? (
        <QualityBlockNotice symbol={symbol} />
      ) : (
        <>
          {/* Institutional verdict — hero */}
          {verdict && <InstitutionalPanel verdict={verdict} />}

          {/* Chart + Order book */}
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-5">
            <Panel
              icon={<LineChart className="size-4 text-primary" />}
              title={`الرسم البياني + الجدران + مناطق السيولة · ${interval.toUpperCase()}`}
              extra={
                <div className="flex gap-1">
                  {TIMEFRAMES.map((tf) => (
                    <button
                      key={tf.value}
                      onClick={() => onInterval(tf.value)}
                      className={cn(
                        "text-[11px] px-2.5 py-1 rounded-md mono font-semibold border",
                        interval === tf.value
                          ? "bg-primary text-primary-foreground border-primary"
                          : "border-border text-muted-foreground hover:text-foreground hover:border-accent"
                      )}
                    >
                      {tf.label}
                    </button>
                  ))}
                </div>
              }
            >
              <div ref={chartContainerRef} id="whaleeye-chart">
                {klines && walls ? (
                  <CandleChart klines={klines} walls={walls} zones={zones} mid={metrics.mid} />
                ) : (
                  <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
                    يحمل بيانات الشموع...
                  </div>
                )}
              </div>
            </Panel>

            <Panel
              icon={<BookOpen className="size-4 text-primary" />}
              title="دفتر الأوامر الحي"
              extra={<span className="text-[10px] mono text-muted-foreground">عمق 20 / تحديث 100ms</span>}
            >
              <OrderBookHeatmap book={book} metrics={metrics} rows={14} />
            </Panel>
          </div>

          {/* Book metrics strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <MetricCard label="اختلال الدفتر" value={`${(metrics.imbalance * 100).toFixed(1)}%`} tone={metrics.imbalance > 0 ? "bull" : "bear"} />
            <MetricCard label="ضغط شراء" value={fmtUsd(metrics.bidUsd)} tone="bull" />
            <MetricCard label="ضغط بيع" value={fmtUsd(metrics.askUsd)} tone="bear" />
            <MetricCard label="السعر الميكروي" value={fmtPrice(metrics.microPrice)} />
            <MetricCard label="VWAP شراء" value={fmtPrice(metrics.vwapBid)} tone="bull" />
            <MetricCard label="VWAP بيع" value={fmtPrice(metrics.vwapAsk)} tone="bear" />
          </div>

          {/* Walls + Liquidity */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <Panel
              icon={<Crosshair className="size-4 text-primary" />}
              title="الجدران السعرية (دعوم ومقاومات)"
              extra={
                <span className="text-[10px] mono text-muted-foreground">
                  {walls?.used.method === "zscore" && `z ≥ ${walls.used.zThreshold}`}
                  {walls?.used.method === "percentile" && `p${walls.used.percentile}`}
                  {walls?.used.method === "absolute" && `≥ ${fmtUsd(walls.used.absoluteUsd)}`}
                  {` · عمق ${walls?.used.depth} · cutoff ${fmtUsd(walls?.used.cutoffUsd ?? 0)}`}
                </span>
              }
            >
              {walls ? <WallsPanel report={walls} mid={metrics.mid} /> : null}
            </Panel>

            <Panel
              icon={<Crosshair className="size-4 text-gold" />}
              title="مناطق صيد الستوبات (السيولة)"
              extra={<span className="text-[10px] mono text-muted-foreground">قمم/قيعان متساوية على {interval}</span>}
            >
              <LiquidityZonesPanel zones={zones} mid={metrics.mid} />
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "bull" | "bear" }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("mono font-bold text-base", tone === "bull" && "text-bull", tone === "bear" && "text-bear")}>
        {value}
      </div>
    </div>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: string; tone?: "bull" | "bear" }) {
  return (
    <div className="rounded-xl border border-border bg-card/50 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("mt-1 mono font-bold text-base", tone === "bull" && "text-bull", tone === "bear" && "text-bear")}>
        {value}
      </div>
    </div>
  );
}

function Panel({
  icon, title, extra, children,
}: { icon?: React.ReactNode; title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-card/40 overflow-hidden">
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-card/60 gap-2 flex-wrap">
        <div className="flex items-center gap-2 font-semibold text-sm">{icon}{title}</div>
        {extra}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function LoadingSkeleton({ symbol }: { symbol: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card/40 p-8 text-center">
      <div className="size-12 rounded-full bg-primary/20 mx-auto mb-4 animate-pulse" />
      <div className="font-bold text-lg">جاري الاتصال بـ Binance...</div>
      <div className="text-sm text-muted-foreground mt-1">تحميل دفتر أوامر {symbol}</div>
    </div>
  );
}
