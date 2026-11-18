/** UI-only replay selection. These are curated development examples, never new evaluation evidence. */
import { DEFAULT_CONFIG, type SimConfig } from "./sim/simulate";
import { episodeConfig } from "./ml/episodes";

export const SCENARIOS = [
  { id: "original", title: "01 / Forest pursuit", description: "Original curated forest. Follow sudden turns, tree cover and low search.", config: DEFAULT_CONFIG },
  { id: "forest", title: "02 / Another forest", description: "Development test-0: a different forest and subject seed, within the same hand-written behavior family.", config: episodeConfig(40000, 45000) },
  { id: "challenge", title: "03 / Retained ML failure", description: "Development test-46: learned guidance previously spent 67.8 s unobserved versus 33.4 s for Kalman. A retained failure, not a promise of success.", config: episodeConfig(40046, 45046) },
] as const;
export function scenarioFromQuery(q: URLSearchParams): { id: string; title: string; description: string; config: SimConfig } {
  return SCENARIOS.find((s) => s.id === q.get("scenario")) ?? SCENARIOS[0];
}
