// src/lib/applyActionToBot.ts
export type RLResult = { action: number; logits?: number[]; value?: number };

export function applyActionToBot(action: number, result?: RLResult) {
  switch (action) {
    case 0:
      console.log("RL: HOLD");
      break;
    case 1:
      console.log("RL: OPEN LONG");
      break;
    case 2:
      console.log("RL: OPEN SHORT");
      break;
    case 3:
      console.log("RL: PLACE SAFETY ORDER");
      break;
    case 4:
      console.log("RL: CLOSE POSITION");
      break;
    default:
      console.warn("RL: unknown action", action);
  }
  if (result) console.debug("RL result:", result);
}
