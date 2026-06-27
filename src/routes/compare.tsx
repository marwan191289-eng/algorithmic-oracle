import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useSession, type LiveSignalSample } from "@/lib/session-store";
import type { BacktestResult, BacktestTrade } from "@/lib/backtest";
import { ArrowLeft, GitCompare, BookOpen, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/compare")({
  head: () => ({ meta: [{ title: "Live vs Backtest — WhaleEye" }] }),
  component: ComparePage,
});

interface MatchedSignal {
  liveT: number;
  side: "long" | "short";
  liveScore: number;
  liveMid: number;
  btTrade: BacktestTrade | null;   // closest BT trade in time
  agrees: boolean | null;          // direction match
  pnlPct: number | null;           // BT outcome
}

function matchSignals(live: LiveSignalSample[], r: BacktestResult): MatchedSignal[] {
  if (!live.length || !r) return [];
  return live
    .filter((s) => s.side !== "none" && s.symbol === r.symbol)
    .map((s) => {
      // nearest BT trade within ±2h of this live signal
      let best: BacktestTrade | null = null;
      let bestDt = Infinity;
      for (const t of r.trades) {
        const dt = Math.abs(t.entryTime - s.t);
        if (dt < bestDt && dt < 2 * 3600_000) { bestDt = dt; best = t; }
      }
      return {
        liveT: s.t,
        side: s.side as "long" | "short",
        liveScore: s.score,
        liveMid: s.mid,
        btTrade: best,
        agrees: best ? best.side === s.side : null,
        pnlPct: best ? best.pnlPct : null,
      };
    });
}

function ComparePage() {
  const r = useSession((s) => s.lastBacktest);
  const allLog = useSession((s) => s.liveSignalLog);

  const live = useMemo<LiveSignalSample[]>(() => {
    if (!r) return [];
    const arr = allLog[r.symbol] ?? [];
    return arr.filter((s) => s.t >= r.fromTime && s.t <= Date.now());
  }, [r, allLog]);

  const matches = useMemo(() => (r ? matchSignals(live, r) : []), [live, r]);

  // KPIs
  const liveSignals = live.filter((s) => s.side !== "none").length;
  const matched = matches.filter((m) => m.btTrade).length;
  const agreed = matches.filter((m) => m.agrees).length;
  const directionAcc = matched ? (agreed / matched) * 100 : 0;

  const liveWins = matches.filter((m) => (m.pnlPct ?? 0) > 0).length;
  const liveLossesCount = matches.filter((m) => (m.pnlPct ?? 0) <= 0 && m.btTrade).length;
  const liveWR = matched ? (liveWins / matched) * 100 : 0;
  const liveAvgPnl =
    matched ? matches.reduce((s, m) => s + (m.pnlPct ?? 0), 0) / matched : 0;
  const btWR = r ? r.winRate : 0;
  const btAvg = r ? r.avgTradePct : 0;
  const wrDelta = liveWR - btWR;
  const avgDelta = liveAvgPnl - btAvg;

  return (
    <div dir="rtl" className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/40 backdrop-blur sticky top-0 z-30">
        <div className="container py-3 flex items-center justify-between gap-3">
          <h1 className="text-lg md:text-xl font-bold flex items-center gap-2">
            <GitCompare className="size-5 text-primary" />
            <span className="text-primary">WhaleEye</span> / Live vs Backtest
          </h1>
          <div className="flex gap-2">
            <Link to="/backtest" className="text-xs px-3 py-1.5 rounded border border-border hover:bg-card">
              تشغيل Backtest
            </Link>
            <Link to="/" className="text-xs px-3 py-1.5 rounded border border-border hover:bg-card inline-flex items-center gap-1">
              <ArrowLeft className="size-3" /> العودة
            </Link>
          </div>
        </div>
      </header>

      <main className="container py-4 space-y-4">
        {/* Guide */}
        <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-primary mb-2">
            <BookOpen className="size-4" /> ما هذه الصفحة؟ ولماذا؟
          </div>
          <div className="grid md:grid-cols-3 gap-3 text-[12px] leading-relaxed">
            <Card title="الفائدة">
              تكشف بدقّة <strong>أين تأتي العشوائية</strong> في أداء المحرّك المؤسساتي:
              هل المنطق نفسه ضعيف (الباك تيست يخسر)؟ أم أن الانحراف يحدث فقط على البيانات
              الحيّة (تأخر، سيولة، أخبار)؟
            </Card>
            <Card title="آلية العمل">
              يأخذ آخر <strong>سجل إشارات حيّة</strong> ضمن نافذة آخر Backtest، ويقابل كل
              إشارة بأقرب صفقة باك تيست زمنياً (±ساعتين)، ثم يحسب:
              نسبة الفوز الحيّ مقابل الباك تيست، دقة الاتجاه، وفرق متوسط الأرباح.
            </Card>
            <Card title="كيف أستخدمها؟">
              <ol className="list-decimal mr-4 space-y-1">
                <li>افتح اللوحة الرئيسية لبعض الوقت ليتراكم سجل الإشارات.</li>
                <li>شغّل <Link to="/backtest" className="text-primary underline">/backtest</Link> على نفس الزوج/الفريم.</li>
                <li>ارجع هنا — كلما زاد عدد الإشارات المتطابقة كلما زادت موثوقية المقارنة.</li>
              </ol>
            </Card>
          </div>
        </div>

        {!r && (
          <Empty msg="لا توجد نتائج باك تيست محفوظة بعد. شغّل Backtest أولاً." />
        )}

        {r && (
          <>
            <div className="rounded-2xl border border-border bg-card/40 p-3 text-[11px] mono text-muted-foreground flex flex-wrap gap-3">
              <span>الزوج: <span className="text-foreground">{r.symbol}</span></span>
              <span>الفريم: <span className="text-foreground">{r.interval}</span></span>
              <span>نافذة Backtest: {new Date(r.fromTime).toLocaleString("en-GB")} → {new Date(r.toTime).toLocaleString("en-GB")}</span>
              <span>إشارات حيّة في النافذة: <span className="text-foreground">{liveSignals}</span></span>
              <span>متطابقة مع صفقات BT: <span className="text-foreground">{matched}</span></span>
            </div>

            {/* KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Kpi label="دقة الاتجاه (Live vs BT)" value={`${directionAcc.toFixed(1)}%`}
                   tone={directionAcc >= 70 ? "ok" : directionAcc >= 50 ? "warn" : "bad"} />
              <Kpi label="WinRate (Live ↔ BT)"
                   value={`${liveWR.toFixed(1)}% / ${btWR.toFixed(1)}%`}
                   delta={wrDelta} suffix="%" />
              <Kpi label="متوسط الربح %"
                   value={`${liveAvgPnl.toFixed(2)}% / ${btAvg.toFixed(2)}%`}
                   delta={avgDelta} suffix="%" />
              <Kpi label="رابح/خاسر (مطابقة)" value={`${liveWins} / ${liveLossesCount}`} />
            </div>

            {(directionAcc < 50 && matched >= 8) && (
              <div className="rounded-xl border border-bear/40 bg-bear/10 text-bear text-[12px] px-3 py-2 flex items-center gap-2">
                <AlertTriangle className="size-4" />
                دقة الاتجاه &lt; 50% — منطق الإشارة الحيّة ينحرف عن الباك تيست. راجع جودة البيانات، فلتر الثقة، أو إعدادات RSI/ATR.
              </div>
            )}

            {/* Table */}
            <div className="rounded-2xl border border-border bg-card/40 overflow-hidden">
              <div className="px-4 py-3 border-b border-border text-sm font-semibold">
                مطابقة الإشارات
              </div>
              <div className="overflow-x-auto max-h-[480px]">
                <table className="w-full text-[11px] mono">
                  <thead className="sticky top-0 bg-card/90 backdrop-blur text-muted-foreground text-right">
                    <tr>
                      <th className="px-2 py-2">وقت الإشارة الحيّة</th>
                      <th className="px-2 py-2">اتجاه Live</th>
                      <th className="px-2 py-2">Score Live</th>
                      <th className="px-2 py-2">سعر Live</th>
                      <th className="px-2 py-2">صفقة BT المطابقة</th>
                      <th className="px-2 py-2">اتجاه BT</th>
                      <th className="px-2 py-2">PnL BT %</th>
                      <th className="px-2 py-2">تطابق الاتجاه</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matches.map((m, i) => (
                      <tr key={i} className="border-t border-border/60 hover:bg-card/60">
                        <td className="px-2 py-1.5">{new Date(m.liveT).toLocaleTimeString("en-GB")}</td>
                        <td className={cn("px-2 py-1.5", m.side === "long" ? "text-bull" : "text-bear")}>
                          {m.side === "long" ? "شراء" : "بيع"}
                        </td>
                        <td className="px-2 py-1.5">{m.liveScore}</td>
                        <td className="px-2 py-1.5">{m.liveMid.toFixed(4)}</td>
                        <td className="px-2 py-1.5 text-muted-foreground">
                          {m.btTrade ? new Date(m.btTrade.entryTime).toLocaleTimeString("en-GB") : "—"}
                        </td>
                        <td className={cn("px-2 py-1.5",
                          m.btTrade?.side === "long" ? "text-bull"
                          : m.btTrade?.side === "short" ? "text-bear" : "text-muted-foreground")}>
                          {m.btTrade ? (m.btTrade.side === "long" ? "شراء" : "بيع") : "—"}
                        </td>
                        <td className={cn("px-2 py-1.5 font-semibold",
                          (m.pnlPct ?? 0) > 0 ? "text-bull" : m.btTrade ? "text-bear" : "text-muted-foreground")}>
                          {m.btTrade ? `${(m.pnlPct! >= 0 ? "+" : "")}${m.pnlPct!.toFixed(2)}%` : "—"}
                        </td>
                        <td className={cn("px-2 py-1.5 font-bold",
                          m.agrees == null ? "text-muted-foreground"
                          : m.agrees ? "text-bull" : "text-bear")}>
                          {m.agrees == null ? "—" : m.agrees ? "✓" : "✗"}
                        </td>
                      </tr>
                    ))}
                    {matches.length === 0 && (
                      <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">
                        لا توجد إشارات حيّة ضمن نافذة الباك تيست بعد.
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <div className="font-semibold text-sm text-primary mb-1">{title}</div>
      <div className="text-foreground/85">{children}</div>
    </div>
  );
}
function Empty({ msg }: { msg: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
      {msg}
    </div>
  );
}
function Kpi({ label, value, tone = "neutral", delta, suffix = "" }: {
  label: string; value: string; tone?: "ok" | "warn" | "bad" | "neutral";
  delta?: number; suffix?: string;
}) {
  const cls =
    tone === "ok" ? "text-bull border-bull/30 bg-bull/5"
    : tone === "warn" ? "text-gold border-gold/30 bg-gold/5"
    : tone === "bad" ? "text-bear border-bear/30 bg-bear/5"
    : "text-foreground border-border bg-card/40";
  return (
    <div className={cn("rounded-xl border px-3 py-2", cls)}>
      <div className="text-[10px] opacity-70">{label}</div>
      <div className="text-base font-bold mono mt-0.5">{value}</div>
      {delta != null && Number.isFinite(delta) && (
        <div className={cn("text-[10px] mono mt-0.5",
          delta > 0 ? "text-bull" : delta < 0 ? "text-bear" : "text-muted-foreground")}>
          Δ Live − BT: {delta >= 0 ? "+" : ""}{delta.toFixed(2)}{suffix}
        </div>
      )}
    </div>
  );
}
