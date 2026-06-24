import { SYMBOLS, fmtPct, fmtPrice, fmtUsd } from "@/lib/binance";
import { useLiveTickers } from "@/hooks/useBinance";
import { cn } from "@/lib/utils";

export function SymbolBar({
  active,
  onSelect,
}: {
  active: string;
  onSelect: (s: string) => void;
}) {
  const tickers = useLiveTickers(SYMBOLS);

  return (
    <div className="flex gap-2 overflow-x-auto pb-2 px-1 -mx-1 scrollbar-thin">
      {SYMBOLS.map((s) => {
        const t = tickers[s];
        const up = (t?.changePct ?? 0) >= 0;
        const isActive = s === active;
        return (
          <button
            key={s}
            onClick={() => onSelect(s)}
            className={cn(
              "shrink-0 rounded-xl px-4 py-3 text-right transition-all border",
              "min-w-[148px] glass hover:scale-[1.02]",
              isActive
                ? "border-primary glow-neon"
                : "border-border hover:border-accent"
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted-foreground mono">
                {fmtUsd(t?.quoteVolume ?? 0)}
              </span>
              <span className="font-bold text-foreground text-sm">
                {s.replace("USDT", "")}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span
                className={cn(
                  "text-[11px] mono font-semibold px-1.5 py-0.5 rounded",
                  up
                    ? "text-bull bg-[var(--bull-soft)]"
                    : "text-bear bg-[var(--bear-soft)]"
                )}
              >
                {t ? fmtPct(t.changePct) : "—"}
              </span>
              <span className="mono text-sm text-foreground">
                {t ? fmtPrice(t.last) : "—"}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
