import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useSession } from "@/lib/session-store";
import { fmtPct, fmtPrice, fmtUsd } from "@/lib/binance";
import { ArrowLeft, Download, FileText, Printer } from "lucide-react";
import { cn } from "@/lib/utils";
import { Signature } from "@/components/ui/Signature";

export const Route = createFileRoute("/report")({
  head: () => ({
    meta: [{ title: "تقرير التحليل — WhaleEye" }],
  }),
  component: ReportPage,
});

function ReportPage() {
  const snap = useSession((s) => s.snapshot);
  const printRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);

  const exportPdf = async () => {
    if (!printRef.current) return;
    setBusy(true);
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import("html2canvas"),
        import("jspdf"),
      ]);
      const canvas = await html2canvas(printRef.current, {
        backgroundColor: "#0a0a0f",
        scale: 2,
        useCORS: true,
        windowWidth: printRef.current.scrollWidth,
      });
      const imgData = canvas.toDataURL("image/jpeg", 0.92);
      const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const imgW = pageW;
      const imgH = (canvas.height * imgW) / canvas.width;

      let heightLeft = imgH;
      let position = 0;
      pdf.addImage(imgData, "JPEG", 0, position, imgW, imgH);
      heightLeft -= pageH;
      while (heightLeft > 0) {
        position -= pageH;
        pdf.addPage();
        pdf.addImage(imgData, "JPEG", 0, position, imgW, imgH);
        heightLeft -= pageH;
      }
      const date = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      pdf.save(`WhaleEye_${snap?.symbol ?? "report"}_${date}.pdf`);
    } finally {
      setBusy(false);
    }
  };

  if (!snap) {
    return (
      <div className="min-h-screen flex items-center justify-center text-foreground">
        <div className="text-center max-w-md p-6 rounded-2xl border border-border bg-card/40">
          <FileText className="size-10 text-muted-foreground mx-auto mb-3" />
          <div className="font-bold text-lg">لا توجد جلسة تحليل محفوظة بعد</div>
          <div className="text-sm text-muted-foreground mt-1">
            افتح لوحة WhaleEye وانتظر ظهور النتائج لحظات، ثم ارجع هنا لتوليد التقرير.
          </div>
          <Link
            to="/"
            className="mt-4 inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-primary text-primary-foreground"
          >
            <ArrowLeft className="size-4" /> العودة للوحة
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen text-foreground">
      {/* Action bar */}
      <div className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="max-w-[900px] mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <Link
            to="/"
            className="text-xs mono inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border bg-card/60 hover:bg-card"
          >
            <ArrowLeft className="size-3.5" /> اللوحة
          </Link>
          <div className="font-bold text-sm">تقرير الجلسة — {snap.symbol}</div>
          <div className="flex gap-2">
            <button
              onClick={() => window.print()}
              className="text-xs mono inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border bg-card/60 hover:bg-card"
            >
              <Printer className="size-3.5" /> طباعة
            </button>
            <button
              onClick={exportPdf}
              disabled={busy}
              className="text-xs mono inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground disabled:opacity-50"
            >
              <Download className="size-3.5" /> {busy ? "جاري التوليد..." : "تنزيل PDF"}
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-[900px] mx-auto p-4">
        <div
          ref={printRef}
          dir="rtl"
          className="bg-background border border-border rounded-2xl p-8 space-y-6"
          style={{ fontFamily: "inherit" }}
        >
          <ReportHeader snap={snap} />
          <VerdictSection snap={snap} />
          <BookSection snap={snap} />
          <WallsSection snap={snap} />
          <ZonesSection snap={snap} />
          <QualitySection snap={snap} />
          <Footer />
        </div>
      </div>
    </div>
  );
}

type Snap = NonNullable<ReturnType<typeof useSession.getState>["snapshot"]>;

function ReportHeader({ snap }: { snap: Snap }) {
  const up = (snap.ticker?.changePct ?? 0) >= 0;
  return (
    <div className="border-b border-border pb-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[11px] mono text-muted-foreground">WhaleEye / عين الحوت — Institutional Report</div>
          <div className="font-extrabold text-2xl mt-1">
            {snap.symbol.replace("USDT", "")}/USDT
            <span className="text-primary text-base mr-2">· {snap.interval.toUpperCase()}</span>
          </div>
        </div>
        <div className="text-left">
          <div className="mono text-3xl font-bold">{fmtPrice(snap.mid)}</div>
          {snap.ticker && (
            <div className={cn("mono text-sm font-semibold", up ? "text-bull" : "text-bear")}>
              {fmtPct(snap.ticker.changePct)} (24س)
            </div>
          )}
        </div>
      </div>
      <div className="mt-2 text-[11px] mono text-muted-foreground">
        تاريخ التقرير: {new Date(snap.capturedAt).toLocaleString("ar-EG")}
      </div>
    </div>
  );
}

function VerdictSection({ snap }: { snap: Snap }) {
  const v = snap.verdict;
  const tone =
    v.score >= 30 ? "text-bull border-bull/40 bg-bull/10"
    : v.score <= -30 ? "text-bear border-bear/40 bg-bear/10"
    : "text-foreground border-border bg-card/40";
  return (
    <section>
      <H title="① الحكم المؤسساتي النهائي" />
      <div className={cn("rounded-xl border p-4", tone)}>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs opacity-80">التحيز</div>
            <div className="font-extrabold text-xl">{v.label}</div>
            <div className="text-xs mt-1 opacity-80">
              جهة الحيتان: {v.whaleSide === "buyers" ? "مشترون" : v.whaleSide === "sellers" ? "بائعون" : "متوازن"}
            </div>
          </div>
          <div className="text-left">
            <div className="text-xs opacity-80">المؤشر المركب</div>
            <div className="mono font-extrabold text-3xl">{v.score.toFixed(0)}</div>
            <div className="text-[10px] mono opacity-60">المدى −100 .. +100</div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-2 text-[10px] mono">
          <Comp label="اختلال الدفتر" v={v.components.bookImbalance} />
          <Comp label="ضغط الجدران" v={v.components.wallPressure} />
          <Comp label="الزخم" v={v.components.momentum} />
          <Comp label="اتجاه الحجم" v={v.components.volumeTrend} />
          <Comp label="صحة السبريد" v={v.components.spreadHealth} unsigned />
        </div>
        {v.reasoning.length > 0 && (
          <ul className="mt-3 list-disc pr-5 text-xs space-y-1 text-foreground">
            {v.reasoning.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        )}
      </div>
    </section>
  );
}

function Comp({ label, v, unsigned }: { label: string; v: number; unsigned?: boolean }) {
  const tone = unsigned ? "text-foreground" : v > 0.05 ? "text-bull" : v < -0.05 ? "text-bear" : "text-muted-foreground";
  return (
    <div className="rounded border border-border bg-background/30 px-2 py-1.5">
      <div className="opacity-70">{label}</div>
      <div className={cn("font-bold", tone)}>{(v * 100).toFixed(1)}{unsigned ? "%" : ""}</div>
    </div>
  );
}

function BookSection({ snap }: { snap: Snap }) {
  const m = snap.metrics;
  return (
    <section>
      <H title="② تحليل دفتر الأوامر" />
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs mono">
        <KV k="السعر الوسطي" v={fmtPrice(m.mid)} />
        <KV k="السعر الميكروي" v={fmtPrice(m.microPrice)} />
        <KV k="السبريد %" v={`${m.spreadPct.toFixed(4)}%`} />
        <KV k="ضغط شراء" v={fmtUsd(m.bidUsd)} tone="bull" />
        <KV k="ضغط بيع" v={fmtUsd(m.askUsd)} tone="bear" />
        <KV k="اختلال" v={`${(m.imbalance * 100).toFixed(1)}%`} tone={m.imbalance > 0 ? "bull" : "bear"} />
        <KV k="VWAP شراء" v={fmtPrice(m.vwapBid)} tone="bull" />
        <KV k="VWAP بيع" v={fmtPrice(m.vwapAsk)} tone="bear" />
      </div>
    </section>
  );
}

function WallsSection({ snap }: { snap: Snap }) {
  const w = snap.walls;
  return (
    <section>
      <H title="③ الجدران السعرية (الدعوم والمقاومات)" />
      <div className="text-[10px] mono text-muted-foreground mb-2">
        طريقة: {w.used.method} · عمق {w.used.depth} ·
        {w.used.method === "zscore" && ` z≥${w.used.zThreshold}`}
        {w.used.method === "percentile" && ` p${w.used.percentile}`}
        {w.used.method === "absolute" && ` ≥${fmtUsd(w.used.absoluteUsd)}`}
        {" · cutoff " + fmtUsd(w.used.cutoffUsd)}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <WallList title="دعوم (شراء)" walls={w.bidWalls} tone="bull" />
        <WallList title="مقاومات (بيع)" walls={w.askWalls} tone="bear" />
      </div>
    </section>
  );
}

function WallList({ title, walls, tone }: { title: string; walls: Snap["walls"]["bidWalls"]; tone: "bull" | "bear" }) {
  const cls = tone === "bull" ? "text-bull" : "text-bear";
  return (
    <div className="rounded-lg border border-border p-2">
      <div className={cn("font-bold text-xs mb-1.5", cls)}>{title}</div>
      {walls.length === 0 && <div className="text-[10px] mono text-muted-foreground">لا توجد</div>}
      <div className="space-y-1">
        {walls.slice(0, 6).map((w) => (
          <div key={`${w.side}-${w.price}`} className="flex justify-between text-[11px] mono">
            <span>#{w.rank} {fmtPrice(w.price)}</span>
            <span className="text-muted-foreground">{w.distancePct.toFixed(2)}%</span>
            <span className={cls}>{fmtUsd(w.usd)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ZonesSection({ snap }: { snap: Snap }) {
  return (
    <section>
      <H title="④ مناطق صيد الستوبات (السيولة)" />
      {snap.zones.length === 0 && (
        <div className="text-xs text-muted-foreground">لم يتم رصد مناطق سيولة عالية الاحتمال على {snap.interval}.</div>
      )}
      <div className="grid grid-cols-2 gap-2">
        {snap.zones.slice(0, 8).map((z, i) => (
          <div key={i} className="rounded border border-border p-2 text-[11px] mono">
            <div className="flex justify-between">
              <span className={z.side === "above" ? "text-bear" : "text-bull"}>
                {z.side === "above" ? "▲ فوق (ستوبات شورت)" : "▼ تحت (ستوبات لونغ)"}
              </span>
              <span className="font-bold">{z.probability.toFixed(0)}%</span>
            </div>
            <div className="flex justify-between mt-1">
              <span>{fmtPrice(z.price)}</span>
              <span className="text-muted-foreground">{z.distancePct.toFixed(2)}% · لمسات {z.touches}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function QualitySection({ snap }: { snap: Snap }) {
  const q = snap.quality;
  if (!q) return null;
  return (
    <section>
      <H title="⑤ جودة البيانات وقت التقاط الجلسة" />
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-[11px] mono">
        <KV k="الاتصال" v={q.connected ? "حي" : "منقطع"} />
        <KV k="معدل التحديث" v={`${q.updateRateHz.toFixed(1)} Hz`} />
        <KV k="التأخر" v={`${q.latencyMs.toFixed(0)} ms`} />
        <KV k="الانقطاعات" v={`${q.disconnects}`} />
        <KV k="الدقة" v={`${q.score}/100 (${q.level})`} />
      </div>
    </section>
  );
}

function Footer() {
  return (
    <div className="pt-4 border-t border-border text-center space-y-3">
      <Signature />
      <div className="text-[10px] mono text-muted-foreground">
        WhaleEye · مصدر البيانات: Binance Public API · هذا التقرير لأغراض تحليلية ولا يُعد توصية استثمارية
      </div>
    </div>
  );
}

function H({ title }: { title: string }) {
  return <h2 className="font-bold text-base mb-2 border-b border-border pb-1">{title}</h2>;
}

function KV({ k, v, tone }: { k: string; v: string; tone?: "bull" | "bear" }) {
  return (
    <div className="rounded border border-border bg-card/30 px-2 py-1.5 flex justify-between">
      <span className="text-muted-foreground">{k}</span>
      <span className={cn("font-semibold", tone === "bull" && "text-bull", tone === "bear" && "text-bear")}>{v}</span>
    </div>
  );
}
