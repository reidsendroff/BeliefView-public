import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  simulatedGps,
  simulatedGpsText,
  SIMULATED_GPS,
} from "../src/team/simulatedGps";
describe("display-only simulated GPS", () => {
  it("uses one signed origin with east/north convention and algebraic roundtrip", () => {
    expect(simulatedGps({ x: 0, z: 0 })).toEqual({
      latitude: 45,
      longitude: -93,
    });
    expect(simulatedGpsText({ x: 0, z: 0 })).toBe("45.000000, -93.000000");
    expect(simulatedGps({ x: 10, z: 10 })!.longitude).toBeGreaterThan(-93);
    expect(simulatedGps({ x: 10, z: 10 })!.latitude).toBeGreaterThan(45);
    for (const x of [-150, 0, 150])
      for (const z of [-150, 0, 150]) {
        const g = simulatedGps({ x, z })!,
          r = SIMULATED_GPS.radiusM,
          cos = Math.cos(Math.PI / 4);
        expect(
          Math.abs((((g.longitude + 93) * Math.PI) / 180) * r * cos - x),
        ).toBeLessThan(1e-6);
        expect(
          Math.abs((((g.latitude - 45) * Math.PI) / 180) * r - z),
        ).toBeLessThan(1e-6);
        const [lat, lon] = simulatedGpsText({ x, z }).split(", ").map(Number);
        expect(
          Math.hypot(
            (((lon + 93) * Math.PI) / 180) * r * cos - x,
            (((lat - 45) * Math.PI) / 180) * r - z,
          ),
        ).toBeLessThan(0.1);
      }
  });
  it("rejects nonfinite/non-numeric inputs without crashing or clamping noisy map coordinates", () => {
    for (const x of [NaN, Infinity, -Infinity, "1", undefined])
      expect(simulatedGps({ x: x as number, z: 0 })).toBeNull();
    expect(simulatedGpsText({ x: NaN, z: 0 })).toBe("unavailable");
    expect(simulatedGps({ x: 96, z: 96 })).not.toBeNull();
    expect(simulatedGpsText({ x: -1e-12, z: -1e-12 })).toBe(
      "45.000000, -93.000000",
    );
  });
  it("uses reported coordinates only and never reads hidden truth", () => {
    const observation = {
      x: 8,
      z: 16,
      get subject() {
        throw Error("truth leak");
      },
    };
    const before = simulatedGpsText(observation);
    const frame = { observation, subject: { x: 80, z: 80 } };
    frame.subject = { x: -80, z: -80 };
    expect(simulatedGpsText(frame.observation)).toBe(before);
    expect(before).not.toBe(simulatedGpsText(frame.subject));
  });
  it("is imported only by the UI, never numeric policy modules", () => {
    for (const file of readdirSync("src/team").filter(
      (f) => f.endsWith(".ts") && !["app.ts", "simulatedGps.ts"].includes(f),
    ))
      expect(readFileSync("src/team/" + file, "utf8")).not.toMatch(
        /from ["']\.\/simulatedGps/,
      );
    const app = readFileSync("src/team/app.ts", "utf8");
    expect(app).toContain("simulatedGpsText({");
    expect(app).not.toMatch(/simulatedGpsText\([^)]*subject/);
  });
});
