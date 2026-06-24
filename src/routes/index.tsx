import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
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
  institutionalScore,
} from "@/lib/analysis";
import { SymbolBar } from "@/components/trading/SymbolBar";
import { OrderBookHeatmap } from "@/components/trading/OrderBookHeatmap";
import { WallsPanel } from "@/components/trading/WallsPanel";
import { LiquidityZonesPanel } from "@/components/trading/LiquidityZonesPanel";
import { InstitutionalPanel } from "@/components/trading/InstitutionalPanel";
import { CandleChart } from "@/components/trading/CandleChart";
import { cn } from "@/lib/utils";
import { Radio, Zap, BookOpen, Crosshair, LineChart } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "WhaleEye — منصة التحليل المؤسساتي للعملات الرقمية" },
      {
        name: "description",
        content:
          "خوارزمية تحليل مؤسساتية لدفتر الأوامر، الجدران السعرية، ومناطق صيد الستوبات لأهم العملات الرقمية على Binance.",
      },
      { property: "og:title", content: "WhaleEye — تحليل الحيتان والمؤسسات" },
      {
        property: "og:description",
        content:
          "اقرأ السوق بعقلية المؤسسات: دفتر أوامر حي، جدران سعرية، صيد ستوبات، ومؤشر مركّب فوري.",
      },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const [symbol, setSymbol] = useState<string>(SYMBOLS[0]);
  const [interval, setInterval] = useState<Interval>("1h");

  return (
    <div className="min-h-screen text-foreground scan-line">
      <Header />
      <main className="max-w-[1600px] mx-auto px-4 md:px-6 pb-12 space-y-5">
        <SymbolBar active={symbol} onSelect={setSymbol} />
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
        <div className="hidden sm:flex items-center gap-2 text-[11px] mono text-muted-foreground">
          <Radio className="size-3 text-bull ticker-pulse" />
          البث المباشر مفعل
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

  const { data: klines } = useQuery({
    queryKey: ["klines", symbol, interval],
    queryFn: () => fetchKlines(symbol, interval, 200),
    refetchInterval: 15000,
  });

  const metrics = useMemo(() => (book ? computeBookMetrics(book, 50) : null), [book]);
  const walls = useMemo(
    () => (book && metrics ? detectWalls(book, metrics.mid) : null),
    [book, metrics]
  );
  const priceMetrics = useMemo(
    () => (klines ? computePriceMetrics(klines) : null),
    [klines]
  );
  const zones = useMemo(
    () =>
      klines && metrics
        ? detectLiquidityZones(klines, metrics.mid)
        : [],
    [klines, metrics]
  );
  const verdict = useMemo(
    () =>
      metrics && walls && priceMetrics
        ? institutionalScore(metrics, walls, priceMetrics)
        : null,
    [metrics, walls, priceMetrics]
  );

  if (!book || !metrics) return <LoadingSkeleton symbol={symbol} />;

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
            <Stat
              label="تغير 24س"
              value={ticker ? fmtPct(ticker.changePct) : "—"}
              tone={up ? "bull" : "bear"}
            />
            <Stat
              label="أعلى 24س"
              value={ticker ? fmtPrice(ticker.high) : "—"}
            />
            <Stat
              label="أدنى 24س"
              value={ticker ? fmtPrice(ticker.low) : "—"}
            />
            <Stat
              label="حجم 24س"
              value={ticker ? fmtUsd(ticker.quoteVolume) : "—"}
            />
          </div>
        </div>
      </div>

      {/* Institutional verdict — hero */}
      {verdict && <InstitutionalPanel verdict={verdict} />}

      {/* Chart + Order book */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-5">
        <Panel
          icon={<LineChart className="size-4 text-primary" />}
          title="الرسم البياني + الجدران + مناطق السيولة"
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
          {klines && walls ? (
            <CandleChart
              klines={klines}
              walls={walls}
              zones={zones}
              mid={metrics.mid}
            />
          ) : (
            <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
              يحمل بيانات الشموع...
            </div>
          )}
        </Panel>

        <Panel
          icon={<BookOpen className="size-4 text-primary" />}
          title="دفتر الأوامر الحي"
          extra={
            <span className="text-[10px] mono text-muted-foreground">
              عمق 20 / تحديث 100ms
            </span>
          }
        >
          <OrderBookHeatmap book={book} metrics={metrics} rows={14} />
        </Panel>
      </div>

      {/* Book metrics strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <MetricCard
          label="اختلال الدفتر"
          value={`${(metrics.imbalance * 100).toFixed(1)}%`}
          tone={metrics.imbalance > 0 ? "bull" : "bear"}
        />
        <MetricCard
          label="ضغط شراء"
          value={fmtUsd(metrics.bidUsd)}
          tone="bull"
        />
        <MetricCard
          label="ضغط بيع"
          value={fmtUsd(metrics.askUsd)}
          tone="bear"
        />
        <MetricCard
          label="السعر الميكروي"
          value={fmtPrice(metrics.microPrice)}
        />
        <MetricCard
          label="VWAP شراء"
          value={fmtPrice(metrics.vwapBid)}
          tone="bull"
        />
        <MetricCard
          label="VWAP بيع"
          value={fmtPrice(metrics.vwapAsk)}
          tone="bear"
        />
      </div>

      {/* Walls + Liquidity */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <Panel
          icon={<Crosshair className="size-4 text-primary" />}
          title="الجدران السعرية (دعوم ومقاومات)"
          extra={
            <span className="text-[10px] mono text-muted-foreground">
              σ ≥ 2.5 على أعمق 200 مستوى
            </span>
          }
        >
          {walls ? (
            <WallsPanel report={walls} mid={metrics.mid} />
          ) : null}
        </Panel>

        <Panel
          icon={<Crosshair className="size-4 text-gold" />}
          title="مناطق صيد الستوبات (السيولة)"
          extra={
            <span className="text-[10px] mono text-muted-foreground">
              تجميع قمم/قيعان متساوية على {interval}
            </span>
          }
        >
          <LiquidityZonesPanel zones={zones} mid={metrics.mid} />
        </Panel>
      </div>
    </div>
  );
}

// ───────────── small UI atoms ─────────────

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bull" | "bear";
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mono font-bold text-base",
          tone === "bull" && "text-bull",
          tone === "bear" && "text-bear"
        )}
      >
        {value}
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bull" | "bear";
}) {
  return (
    <div className="rounded-xl border border-border bg-card/50 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 mono font-bold text-base",
          tone === "bull" && "text-bull",
          tone === "bear" && "text-bear"
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Panel({
  icon,
  title,
  extra,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card/40 overflow-hidden">
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-card/60">
        <div className="flex items-center gap-2 font-semibold text-sm">
          {icon}
          {title}
        </div>
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
      <div className="text-sm text-muted-foreground mt-1">
        تحميل دفتر أوامر {symbol}
      </div>
    </div>
  );
}
