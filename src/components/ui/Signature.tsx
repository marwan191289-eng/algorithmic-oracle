import { Sparkles } from "lucide-react";

export function Signature() {
  return (
    <div className="flex flex-col items-center gap-2 py-3 select-none pointer-events-none">
      <div className="neon-line w-48" />
      <div className="flex items-center gap-2">
        <Sparkles className="size-3 text-neon animate-pulse" />
        <span className="neon-signature font-mono text-[11px] tracking-[0.15em] uppercase font-bold">
          DEVeloper: Marwan Negm
        </span>
        <Sparkles className="size-3 text-neon animate-pulse" />
      </div>
      <div className="neon-line w-48" />
    </div>
  );
}
