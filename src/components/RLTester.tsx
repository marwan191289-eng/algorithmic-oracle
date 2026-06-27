// src/components/RLTester.tsx
import React from "react";
import { callRL } from "@/lib/callRL";
import { applyActionToBot } from "@/lib/applyActionToBot";

export default function RLTester() {
  const handleTest = async () => {
    const state = [0.3, 1.2, -0.7, 0.0];
    try {
      const result = await callRL(state);
      applyActionToBot(result.action, result);
    } catch (err) {
      console.error("callRL error", err);
    }
  };

  return (
    <div>
      <button onClick={handleTest} className="px-3 py-2 bg-slate-700 text-white rounded">
        Test RL Call
      </button>
    </div>
  );
}
