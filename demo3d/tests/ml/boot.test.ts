import { describe, expect, it } from "vitest";
import { bootGuidance } from "../../src/ml/boot";
import { DEFAULT_CONFIG, buildWorld, simulate } from "../../src/sim/simulate";

const h = (tl: ReturnType<typeof simulate>) => JSON.stringify(tl.frames.map((f) => [f.drone.x, f.drone.y, f.drone.z, f.cam.yaw, f.cam.pitch]));
const coarse = simulate(DEFAULT_CONFIG, buildWorld(DEFAULT_CONFIG), "coarse");
const exactRef = simulate(DEFAULT_CONFIG, buildWorld(DEFAULT_CONFIG), "exact"); // evaluation-only reference, never shown in the browser

describe("browser Kalman boot uses the coarse set-up (no subject start reaches the drone)", () => {
  it("coarse and the legacy exact reference really differ at t=0", () => {
    expect(h(coarse)).not.toBe(h(exactRef));
  });
  it("default Kalman boot equals the coarse run, not the exact one", async () => {
    const b = await bootGuidance(new URLSearchParams(), "/", () => {});
    expect(b.active).toBe("kalman");
    expect(h(b.tl)).toBe(h(coarse));
    expect(h(b.tl)).not.toBe(h(exactRef));
  });
  it("error fallback (unloadable manifest) also equals the coarse run", async () => {
    const b = await bootGuidance(new URLSearchParams("guidance=ml&mlManifest=http://127.0.0.1:1/none.json"), "/", () => {});
    expect(b.requested).toBe("ml");
    expect(b.active).toBe("kalman");
    expect(b.error).not.toBeNull();
    expect(h(b.tl)).toBe(h(coarse));
    expect(h(b.tl)).not.toBe(h(exactRef));
  });
});
