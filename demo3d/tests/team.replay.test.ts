import { describe, it, expect } from "vitest";
import {
  replayQuery,
  deterministicReplay,
  digest,
  mapFingerprint,
  spectatorTimeline,
  replayDuration,
  validateReplayHorizon,
} from "../src/team/replay";
import {
  generateTeamScenario,
  buildPublicScenario,
} from "../src/team/scenario";
import { simulateTeam } from "../src/team/runtime";
describe("team replay transport and route boundary", () => {
  it("restricts UI to32 development missions and known arms/families", () => {
    expect(replayQuery(new URLSearchParams())).toEqual({
      fleet: 2,
      duration: 180,
      arm: "shared",
      index: 16,
      family: "rich",
    });
    expect(
      replayQuery(
        new URLSearchParams(
          "teamarm=unknown&missionIndex=320000&terrain=unknown",
        ),
      ),
    ).toEqual({
      fleet: 2,
      duration: 180,
      arm: "shared",
      index: 0,
      family: "rich",
    });
    for (const value of ["-1", "1.5", "NaN", "Infinity", "32"])
      expect(
        replayQuery(new URLSearchParams("missionIndex=" + value)).index,
      ).toBe(0);
  });
  it("bounds duration input and rejects incomplete or wrong-horizon transport", () => {
    for (const value of [
      null,
      "",
      "0",
      "-1",
      "75.5",
      "NaN",
      "Infinity",
      "100000",
      "075",
      "180.0",
    ])
      expect(replayDuration(value)).toBe(180);
    for (const n of [75, 180, 300]) expect(replayDuration(String(n))).toBe(n);
    const timeline = simulateTeam(
      generateTeamScenario(220016, 225016, "original"),
      "shared",
      { duration: 0.1 },
    );
    expect(() => validateReplayHorizon(timeline, 0.1)).not.toThrow();
    expect(() => validateReplayHorizon(timeline, 180)).toThrow(
      "duration mismatch",
    );
    for (const t of [NaN, Infinity, undefined]) {
      const malformed = structuredClone(timeline);
      malformed.frames[1].t = t as number;
      expect(() => validateReplayHorizon(malformed, 0.1)).toThrow(
        "duration mismatch",
      );
    }
    expect(
      spectatorTimeline(timeline, buildPublicScenario(220016, "original"))
        .config.duration,
    ).toBe(0.1);
  });
  it("canonical replay ignores nondeterministic timing and preserves numeric evidence", async () => {
    const scenario = generateTeamScenario(220016, 225016, "original"),
      timeline = simulateTeam(scenario, "shared", { duration: 0.1 });
    const changed = structuredClone(timeline);
    changed.diagnostics.wallMs = 99999;
    expect(await digest(deterministicReplay(changed))).toBe(
      await digest(deterministicReplay(timeline)),
    );
    changed.frames[0].aircraft[0].state.pos.x += 1;
    expect(await digest(deterministicReplay(changed))).not.toBe(
      await digest(deterministicReplay(timeline)),
    );
  });
  it("reconstructs the same public map and keeps A/B actual camera inputs separate", async () => {
    const scenario = generateTeamScenario(220016, 225016, "original"),
      timeline = simulateTeam(scenario, "shared", { duration: 0.1 });
    expect(await mapFingerprint(scenario.public)).toBe(
      await mapFingerprint(buildPublicScenario(220016, "original")),
    );
    const before = JSON.stringify(timeline),
      a = spectatorTimeline(timeline, scenario.public, "A"),
      b = spectatorTimeline(timeline, scenario.public, "B");
    expect(a.frames[0].drone.x).toBe(
      timeline.frames[0].aircraft[0].state.pos.x,
    );
    expect(b.frames[0].drone.x).toBe(
      timeline.frames[0].aircraft[1].state.pos.x,
    );
    expect(a.frames[0].cam.yaw).toBe(
      timeline.frames[0].aircraft[0].state.camYaw,
    );
    expect(b.frames[0].cam.yaw).toBe(
      timeline.frames[0].aircraft[1].state.camYaw,
    );
    expect(a.frames[0].track.initialised).toBe(false);
    expect(a.frames[0].track.status).toBe("SEARCHING");
    expect(JSON.stringify(timeline)).toBe(before);
  });
});
