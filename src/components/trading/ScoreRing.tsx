import { cn } from "@/lib/utils";

const CIRCUMFERENCE = 2 * Math.PI * 48; // r=48

export function ScoreRing({
  score,
  size = 160,
}: {
  score: number;
  size?: number;
}) {
  const pct = (score + 100) / 200;
  const offset = CIRCUMFERENCE * (1 - pct);

  const color =
    score >= 35
      ? "#17c784"
      : score >= 10
      ? "#a3e6b8"
      : score >= -10
      ? "#ffb020"
      : score >= -35
      ? "#ff9060"
      : "#ff4d6d";

  const labelColor =
    score >= 25
      ? "text-bull"
      : score <= -25
      ? "text-bear"
      : "text-gold";

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg
        viewBox="0 0 120 120"
        width={size}
        height={size}
        style={{ transform: "rotate(-90deg)" }}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="scoreGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#ff4d6d" />
            <stop offset="50%" stopColor="#ffb020" />
            <stop offset="100%" stopColor="#17c784" />
          </linearGradient>
        </defs>
        <circle
          cx="60"
          cy="60"
          r="48"
          fill="none"
          stroke="rgba(255,255,255,0.07)"
          strokeWidth="10"
        />
        <circle
          cx="60"
          cy="60"
          r="48"
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.4s ease, stroke 0.4s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className={cn("mono font-extrabold leading-none", labelColor)}
          style={{ fontSize: size * 0.2 }}
        >
          {score > 0 ? "+" : ""}
          {score}
        </span>
        <span
          className="text-muted-foreground uppercase tracking-widest"
          style={{ fontSize: size * 0.065 }}
        >
          Score
        </span>
      </div>
    </div>
  );
}
