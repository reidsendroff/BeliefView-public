import { describe, expect, it } from "vitest";
import { searchStory } from "../src/render/searchStory";
import { SCENARIOS, scenarioFromQuery } from "../src/scenarioCatalog";
import { buildWorld, simulate } from "../src/sim/simulate";
import { bootGuidance } from "../src/ml/boot";
import { readFileSync } from "node:fs";

describe("presentation-only replay selection", () => {
  it("retains original config for missing and invalid presets", () => {
    expect(scenarioFromQuery(new URLSearchParams()).config).toEqual(SCENARIOS[0].config);
    expect(scenarioFromQuery(new URLSearchParams("scenario=garbage")).id).toBe("original");
  });
  it("Kalman boot uses selected config with the same coarse start deterministically", async () => {
    const cfg = SCENARIOS[2].config;
    const boot = await bootGuidance(new URLSearchParams(), "/", () => {}, cfg);
    const repeat = simulate(cfg, buildWorld(cfg), "coarse");
    expect(boot.tl.frames).toEqual(repeat.frames);
    expect(boot.tl.config.seed).toBe(40046);
  });
  it("does not move scenario evaluation code into the inference entry point", () => {
    const source = readFileSync(new URL("../src/ml/boot.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/scenarioCatalog|ml\/episodes|closedLoop/);
  });
});

describe("search explanation has no hidden-state access", () => {
  const frames = simulate().frames;
  it("ignores adversarial truth and visibility getters", () => {
    for (const f of frames.filter((_, i) => i % 100 === 0)) {
      const guarded = new Proxy(f, { get(target, key, receiver) {
        if (["subject", "visibility"].includes(String(key))) throw new Error("hidden state was read");
        return Reflect.get(target, key, receiver);
      } });
      expect(searchStory(guarded, null, null, true)).toEqual(searchStory(f, null, null, true));
    }
  });
  it("does not invent observations before the first fix or infer cause of missing sighting", () => {
    const f = frames[0];
    const initial = { ...f, obs: null, track: { ...f.track, initialised: false } };
    expect(searchStory(initial, null, null, false).intent).toContain("until the first noisy sighting");
    const lost = { ...f, obs: null, track: { ...f.track, status: "COASTING" as const } };
    expect(searchStory(lost, null, null, false).intent).toContain("No missing sighting reveals why");
  });
  it("describes learned-policy plans with an explicit per-choice fallback caveat", () => {
    const f = frames.find((f) => f.track.status === "SEARCHING")!;
    expect(searchStory(f, null, null, true).intent).toContain("individual plans may use Kalman fallback");
    expect(searchStory(f, null, null, true).intent).not.toMatch(/reacquisition probability|subject is hiding/);
  });
});
