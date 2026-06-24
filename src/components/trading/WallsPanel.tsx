import { fmtPct, fmtPrice, fmtUsd } from "@/lib/binance";
import type { WallReport, PriceWall } from "@/lib/analysis";
import { cn } from "@/lib/utils";
import { Shield, Swords } from "lucide-react";

export function WallsPanel({ report, mid }: { report: WallReport; mid: number }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground uppercase tracking-wider">
            <Swords className="size-3.5 text-bear" />
            مقاومات
          </div>
          <div className="mono text-sm text-bear font-bold">
            {fmtUsd(report.askWallUsd)}
          </div>
        </div>
        <WallBalanceBar imbalance={report.wallImbalance} />
        <div className="text-left">
          <div className="flex items-center gap-2 justify-end text-[11px] text-muted-foreground uppercase tracking-wider">
            دعوم
            <Shield className="size-3.5 text-bull" />
          </div>
          <div className="mono text-sm text-bull font-bold text-left">
            {fmtUsd(report.bidWallUsd)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <WallList title="جدران البيع (مقاومات)" walls={report.askWalls} side="ask" />
        <WallList title="جدران الشراء (دعوم)" walls={report.bidWalls} side="bid" />
      </div>
    </div>
  );
}

function WallBalanceBar({ imbalance }: { imbalance: number }) {
  // imbalance ∈ [-1, +1]; positive = bid-heavy
  const pct = (imbalance + 1) * 50;
  return (
    <div className="flex-1 mx-4 max-w-xs">
      <div className="h-2 rounded-full bg-secondary overflow-hidden relative">
        <div
          className="absolute inset-y-0 right-0 bg-gradient-to-l from-bull to-bull/40"
          style={{ width: `${pct}%` }}
        />
        <div
          className="absolute inset-y-0 left-0 bg-gradient-to-r from-bear to-bear/40"
          style={{ width: `${100 - pct}%` }}
        />
        <div className="absolute inset-y-0 left-1/2 w-px bg-foreground/30" />
      </div>
      <div className="text-center mt-1 text-[10px] mono text-muted-foreground">
        ميزان الجدران: {(imbalance * 100).toFixed(0)}%
      </div>
    </div>
  );
}

function WallList({
  title,
  walls,
  side,
}: {
  title: string;
  walls: PriceWall[];
  side: "bid" | "ask";
}) {
  const isBid = side === "bid";
  const max = Math.max(...walls.map((w) => w.usd), 1);

  return (
    <div className="rounded-xl border border-border bg-card/40 p-3">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
        {title}
      </div>
      {walls.length === 0 ? (
        <div className="text-xs text-muted-foreground text-center py-6">
          لا توجد جدران واضحة
        </div>
      ) : (
        <div className="space-y-1.5">
          {walls.map((w) => {
            const widthPct = (w.usd / max) * 100;
            return (
              <div
                key={w.price}
                className="relative rounded-md overflow-hidden border border-border/60"
              >
                <div
                  className={cn(
                    "absolute inset-y-0 right-0",
                    isBid ? "bg-[var(--bull-soft)]" : "bg-[var(--bear-soft)]"
                  )}
                  style={{ width: `${widthPct}%` }}
                />
                <div className="relative grid grid-cols-[auto_1fr_auto_auto] items-center gap-3 px-3 py-2 text-[12px] mono">
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] font-bold",
                      isBid
                        ? "bg-bull/20 text-bull"
                        : "bg-bear/20 text-bear"
                    )}
                  >
                    #{w.rank}
                  </span>
                  <span
                    className={cn(
                      "font-bold",
                      isBid ? "text-bull" : "text-bear"
                    )}
                  >
                    {fmtPrice(w.price)}
                  </span>
                  <span className="text-muted-foreground">
                    {fmtPct(w.distancePct)}
                  </span>
                  <span className="text-foreground font-semibold">
                    {fmtUsd(w.usd)}
                  </span>
                </div>
                <div className="relative flex justify-between px-3 pb-1.5 text-[10px] text-muted-foreground">
                  <span>قوة: σ{w.strength.toFixed(1)}</span>
                  <span>كمية: {w.qty.toFixed(w.qty > 1 ? 2 : 4)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
