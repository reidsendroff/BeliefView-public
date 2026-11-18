import { it, expect } from "vitest";
import { generateThreeScenario } from "../src/team/threeScenario";
import { simulateThreeTeam } from "../src/team/threeRuntime";
it("canonicalizes start order before recording even a short initialization-only replay", () => {
  const scenario = generateThreeScenario(220016, 225016, "original");
  const a = simulateThreeTeam(scenario, "shared", { duration: 0.1 });
  const b = simulateThreeTeam(
    {
      ...scenario,
      public: {
        ...scenario.public,
        starts: [...scenario.public.starts].reverse(),
      },
    },
    "shared",
    { duration: 0.1 },
  );
  expect(b.frames).toEqual(a.frames);
  expect(b.beliefEpochs).toEqual(a.beliefEpochs);
  expect(
    a.frames.every((f) => f.aircraft.map((d) => d.id).join("") === "ABC"),
  ).toBe(true);
  expect(Number.isFinite(a.diagnostics.minSweptSeparationM)).toBe(true);
});
it("rejects invalid initial geometry or pair separation before the first short replay frame", () => {
  const scenario = generateThreeScenario(220016, 225016, "original");
  const starts = scenario.public.starts.map((s) => ({ ...s }));
  starts[2].x = starts[0].x;
  starts[2].z = starts[0].z;
  expect(() =>
    simulateThreeTeam(
      { ...scenario, public: { ...scenario.public, starts } },
      "shared",
      { duration: 0.1 },
    ),
  ).toThrow(/initial clearance or separation/);
  starts[2].x = 1000;
  expect(() =>
    simulateThreeTeam(
      { ...scenario, public: { ...scenario.public, starts } },
      "shared",
      { duration: 0.1 },
    ),
  ).toThrow(/initial clearance or separation/);
});
