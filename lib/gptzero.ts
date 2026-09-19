import type { GptZeroFlag } from "./types";

export interface GptZeroResult {
  score: number | null;
  flag: GptZeroFlag;
}

export async function checkGptZero(text: string): Promise<GptZeroResult> {
  const apiKey = process.env.GPTZERO_API_KEY;
  if (!apiKey) return { score: null, flag: "unavailable" };

  try {
    const res = await fetch("https://api.gptzero.me/v2/predict/text", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ document: text }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return { score: null, flag: "unavailable" };

    const data = await res.json();
    const doc = data?.documents?.[0];
    if (!doc) return { score: null, flag: "unavailable" };

    const probs = doc.class_probabilities as
      | { human?: number; mixed?: number; ai?: number }
      | undefined;
    const score: number = doc.completely_generated_prob ?? probs?.ai ?? 0;

    let flag: GptZeroFlag = "human";
    if (probs) {
      const entries = Object.entries(probs) as [
        "human" | "mixed" | "ai",
        number
      ][];
      flag = entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    } else {
      flag = score > 0.5 ? "ai" : "human";
    }

    return { score, flag };
  } catch {
    return { score: null, flag: "unavailable" };
  }
}
