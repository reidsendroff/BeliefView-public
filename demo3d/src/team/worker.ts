/** Local CPU worker. No network, ONNX loading, rendering controls or user data. */
import { generateTeamScenario } from "./scenario";
import { simulateTeam } from "./runtime";
import { generateThreeScenario } from "./threeScenario";
import { simulateThreeTeam } from "./threeRuntime";
import {
  replayQuery,
  digest,
  deterministicReplay,
  mapFingerprint,
} from "./replay";
self.onmessage = async (event: MessageEvent<{ query: string }>) => {
  try {
    const choice = replayQuery(new URLSearchParams(event.data.query));
    const started = performance.now();
    const scenario = (
      choice.fleet === 3 ? generateThreeScenario : generateTeamScenario
    )(220000 + choice.index, 225000 + choice.index, choice.family);
    const fingerprint = await mapFingerprint(scenario.public);
    self.postMessage({
      type: "progress",
      text: `Public map ready. Computing ${choice.fleet === 3 ? "all three" : "both"} drones and their observations...`,
    });
    const timeline =
      choice.fleet === 3
        ? simulateThreeTeam(scenario, choice.arm, { duration: choice.duration })
        : simulateTeam(scenario, choice.arm, {
            duration: choice.duration,
            assist: true,
            extendedRecovery: true,
          });
    const computeMs = performance.now() - started;
    const timelineDigest = await digest(deterministicReplay(timeline));
    self.postMessage({
      type: "ready",
      timeline,
      fingerprint,
      timelineDigest,
      computeMs,
      serializedBytes: new TextEncoder().encode(JSON.stringify(timeline))
        .byteLength,
    });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
