// src/lib/callRL.ts
export type RLResult = {
  action: number;
  logits?: number[];
  value?: number;
};

export async function callRL(stateVector: number[]): Promise<RLResult> {
  const res = await fetch("/api/rl/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: stateVector }),
  });
  if (!res.ok) throw new Error("RL API error " + res.status);
  return (await res.json()) as RLResult;
}
