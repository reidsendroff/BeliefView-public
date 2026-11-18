import { BODY_VERSION } from "../src/team/threeBody";
import { SUBJECT_VERSION } from "../src/team/threeSubject";
import { THREE_VERSION } from "../src/team/threeConstants";
import { describe, expect, it } from "vitest";
import {
  replayFleet,
  replayFocus,
  replayQuery,
  validateReplayFleet,
  deterministicReplay,
  type ReplayTimeline,
} from "../src/team/replay";
import { simulateTeam } from "../src/team/runtime";
import { generateTeamScenario } from "../src/team/scenario";
import { simulateThreeTeam } from "../src/team/threeRuntime";
import { generateThreeScenario } from "../src/team/threeScenario";
import { teamMarkup } from "../src/team/template";

/** Transport-only fixture: it intentionally contains no simulated dynamics. */
function fixture(fleet: 2 | 3, shared = true): ReplayTimeline {
  const ids = fleet === 3 ? ["A", "B", "C"] : ["A", "B"];
  const rows = () => ids.map((id) => ({ id }));
  return {
    ...(fleet === 3 ? { fleet: 3, policyVersion: THREE_VERSION } : {}),
    frames: [0, 1].map((i) => ({
      i,
      t: i * 0.05,
      ...(fleet === 3
        ? {
            subject: {
              x: 0,
              y: 0,
              z: 0,
              subjectVersion: SUBJECT_VERSION,
              bodyVersion: BODY_VERSION,
              body: {
                root: { x: 0, y: 0, z: 0 },
                heading: 0,
                gait: 0,
                speed: 0,
                posture: { from: "standing", to: "standing", progress: 1 },
              },
            },
            subjectExposure: ids.map((id) => ({
              id,
              visibleSamples: 0,
              geometricallyBlockedSamples: 0,
              inFrameSamples: 0,
              bodyValid: true,
            })),
          }
        : {}),
      aircraft: ids.map((id) => ({
        id,
        state: {
          pos: { x: 0, y: 3, z: 0 },
          vel: { x: 0, y: 0, z: 0 },
          yaw: 0,
          camYaw: 0,
          camPitch: 0,
        },
        observation: null,
      })),
      allocations: rows(),
      recovery: rows(),
      heldIds: [],
      jointYieldIds: [],
      adapterProposedMotion: [],
      commandedMotion: [],
      ...(fleet === 3 ? { viewTasks: [] } : { assist: [] }),
    })),
    decisions: [{ t: 0, allocations: rows() }],
    beliefEpochs: [
      {
        t: 0,
        sensors: (shared && fleet === 3 ? [ids[0]] : ids).map((id) => ({
          id,
          probability: [1],
          ...(fleet === 3 ? { owners: shared ? ids : [id] } : {}),
        })),
      },
    ],
    metrics: {},
    diagnostics: {
      arm: shared ? "shared" : "independent",
      holdSecondsById: Object.fromEntries(ids.map((id) => [id, 0])),
      ledgers: Object.fromEntries(ids.map((id) => [id, {}])),
    },
  } as unknown as ReplayTimeline;
}
describe("fleet replay transport", () => {
  it("accepts actual runtime initialization, active-motion and terminal schemas for both fleets", () => {
    for (const arm of ["shared", "coordinated", "independent"] as const) {
      const two = simulateTeam(
        generateTeamScenario(220016, 225016, "original"),
        arm,
        { duration: 1.1 },
      );
      const three = simulateThreeTeam(
        generateThreeScenario(220016, 225016, "original"),
        arm,
        { duration: 1.1 },
      );
      expect(() => validateReplayFleet(two, 2, arm)).not.toThrow();
      expect(() => validateReplayFleet(three, 3, arm)).not.toThrow();
      const corrupted = structuredClone(three);
      corrupted.frames[20].commandedMotion.pop();
      expect(() => validateReplayFleet(corrupted, 3, arm)).toThrow();
    }
  });
  it("defaults old and malformed fleet URLs to two and bounds focus to the cohort", () => {
    for (const value of [
      null,
      "",
      "2",
      "03",
      "3.0",
      "4",
      "NaN",
      "-1",
      "Infinity",
    ])
      expect(replayFleet(value)).toBe(2);
    expect(replayFleet("3")).toBe(3);
    expect(replayQuery(new URLSearchParams()).fleet).toBe(2);
    expect(replayQuery(new URLSearchParams("fleet=3")).fleet).toBe(3);
    expect(replayFocus("C", 2)).toBe("A");
    expect(replayFocus("C", 3)).toBe("C");
    expect(replayFocus("B", 2)).toBe("B");
    expect(replayFocus("D", 3)).toBe("A");
  });
  it("accepts both exact cohorts and one shared posterior or separate per-drone posteriors", () => {
    for (const fleet of [2, 3] as const)
      for (const shared of [true, false])
        expect(() =>
          validateReplayFleet(
            fixture(fleet, shared),
            fleet,
            shared ? "shared" : "independent",
          ),
        ).not.toThrow();
  });
  it("checks every frame for missing, duplicate, and ghost sensor records", () => {
    for (const fleet of [2, 3] as const)
      for (const change of ["missing", "duplicate", "ghost"]) {
        const t = fixture(fleet),
          frame = t.frames[1];
        if (change === "missing") frame.aircraft.pop();
        if (change === "duplicate") frame.aircraft[1].id = "A";
        if (change === "ghost")
          frame.aircraft[0].id = (fleet === 2 ? "C" : "D") as "A";
        expect(() => validateReplayFleet(t, fleet, "shared")).toThrow(
          "cohort mismatch",
        );
      }
    expect(() => validateReplayFleet(fixture(2), 3, "shared")).toThrow();
    expect(() => validateReplayFleet(fixture(3), 2, "shared")).toThrow();
  });
  it("rejects sources, owners, allocations and diagnostics outside the active cohort", () => {
    const variants = [
      (t: ReplayTimeline) => {
        t.frames[0].allocations[0].id = "C";
      },
      (t: ReplayTimeline) => {
        t.frames[0].heldIds = ["C"];
      },
      (t: ReplayTimeline) => {
        t.diagnostics.holdSecondsById = { A: 0, B: 0, C: 0 };
      },
      (t: ReplayTimeline) => {
        Object.assign(t.frames[0], { assist: [{ id: "A", source: "C" }] });
      },
    ];
    for (const mutate of variants) {
      const t = fixture(2);
      mutate(t);
      expect(() => validateReplayFleet(t, 2, "shared")).toThrow();
    }
    const t = fixture(3);
    Object.assign(t.beliefEpochs[0].sensors[0], { owners: ["A", "B"] });
    expect(() => validateReplayFleet(t, 3, "shared")).toThrow();
    const bad = fixture(3);
    Object.assign(bad.frames[1], {
      viewTasks: [
        { id: "A", estimate: { sources: [{ id: "D" }], excluded: [] } },
      ],
    });
    expect(() => validateReplayFleet(bad, 3, "shared")).toThrow();
  });
  it("rejects matching-hash malformed camera inputs, wrong arm and wrong policy version", () => {
    for (const mutate of [
      (t: ReplayTimeline) => {
        t.frames[0].aircraft[2].state.pos.x = NaN;
      },
      (t: ReplayTimeline) => {
        t.frames[0].aircraft[2].state.camYaw = undefined as unknown as number;
      },
      (t: ReplayTimeline) => {
        t.frames[0].aircraft[2].observation = { t: 0, x: 0, z: 0, sigma: NaN };
      },
      (t: ReplayTimeline) => {
        t.diagnostics.arm = "independent";
      },
      (t: ReplayTimeline) => {
        Object.assign(t, { policyVersion: "old-version" });
      },
    ]) {
      const t = fixture(3);
      mutate(t);
      expect(() => validateReplayFleet(t, 3, "shared")).toThrow();
    }
    const three = fixture(3);
    expect(Object.keys(deterministicReplay(three)).slice(0, 2)).toEqual([
      "fleet",
      "policyVersion",
    ]);
  });
  it("preserves the two-drone canonical numeric object shape and ignores timing", () => {
    const t = fixture(2),
      result = deterministicReplay(t);
    expect(Object.keys(result)).toEqual([
      "frames",
      "decisions",
      "beliefEpochs",
      "metrics",
    ]);
    t.diagnostics.wallMs = 999;
    expect(deterministicReplay(t)).toEqual(result);
  });
  it("renders only active sensor IDs and preserves disclosures, controls and DOM order", () => {
    for (const fleet of [2, 3] as const) {
      const html = teamMarkup({ fleet, duration: 180 });
      expect(html.includes('id="sensor-C"')).toBe(fleet === 3);
      const sensorA = html.indexOf('id="sensor-A"');
      const spectator = html.indexOf('id="spectator-pane"');
      expect(sensorA).toBeGreaterThanOrEqual(0);
      expect(spectator).toBeGreaterThan(sensorA);
      expect(html.indexOf('id="sensor-B"')).toBeLessThan(
        html.indexOf('id="team-evidence-panel"'),
      );
      for (const text of [
        "ONNX is not loaded or used here",
        "not calibrated confidence",
        "not available to the drones",
        "Simulated GPS",
        'id="team-method-open"',
        'id="team-fleet"',
        'id="team-duration"',
      ])
        expect(html).toContain(text);
    }
  });
});
