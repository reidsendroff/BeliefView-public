/** Actual local production-browser engineering evidence. No performance-superiority claim. */
import { chromium } from "playwright-core";
import { preview } from "vite";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const out =
  process.env.BV_TEAM_SHOT_DIR ?? `${root}output/playwright/team-demo`;
mkdirSync(out, { recursive: true });
const server = await preview({
    root,
    preview: { port: 4185, strictPort: true, host: "127.0.0.1" },
  }),
  base = "http://127.0.0.1:4185/";
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: false,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const checks = [],
  errors = [],
  consoleErrors = [],
  requests = [],
  examples = [],
  layouts = [],
  motions = [],
  pixels = [],
  faultEvidence = [];
const check = (ok, name, detail) => {
  checks.push({ ok: !!ok, name, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
};
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("request", (r) => requests.push(r.url()));
const sha = (b) => createHash("sha256").update(b).digest("hex");
async function open(q = "") {
  const params = new URLSearchParams(
    "mission=team&duration=75&paused=1&missionIndex=16&terrain=rich",
  );
  for (const [k, v] of new URLSearchParams(q)) params.set(k, v);
  await page.goto(base + "?" + params);
  await page.waitForFunction(() => window.__team?.firstFrameMs > 0, null, {
    timeout: 180000,
  });
  await page.waitForTimeout(250);
}
const state = () =>
  page.evaluate(() => ({
    time: window.__team.time,
    playing: window.__team.playing,
    speed: window.__team.speed,
    mode: window.__team.mode,
    focus: window.__team.focus,
    digest: window.__team.timelineDigest,
    map: window.__team.mapFingerprint,
    firstFrameMs: window.__team.firstFrameMs,
    computeMs: window.__team.computeMs,
    p95: window.__team.frameP95Ms,
    maximumFrameIntervalMs: window.__team.maximumFrameIntervalMs,
    frames: window.__team.timeline.frames.length,
    arm: window.__team.arm,
    family: window.__team.family,
    missionIndex: window.__team.missionIndex,
  }));
async function settle() {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.waitForTimeout(150);
}
async function actualDigest() {
  return page.evaluate(async () => {
    const t = window.__team.timeline;
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        frames: t.frames,
        decisions: t.decisions,
        beliefEpochs: t.beliefEpochs,
        metrics: t.metrics,
      }),
    );
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
  });
}
function persist() {
  writeFileSync(
    process.env.BV_TEAM_REPORT ?? `${root}ml/results/team_browser.json`,
    JSON.stringify(
      {
        role: "Local UI engineering evidence, development scenarios only",
        checks,
        errors,
        consoleErrors,
        requests,
        examples,
        layouts,
        motions,
        pixels,
        faultEvidence,
      },
      null,
      2,
    ),
  );
}
try {
  if (process.env.BV_TEAM_MOTION_ONLY !== "1") {
    for (const terrain of ["original", "rich"])
      for (const arm of ["independent", "sector", "shared", "coordinated"]) {
        await open(`&terrain=${terrain}&teamarm=${arm}&t=12&cam=ground`);
        const s = await state();
        examples.push(s);
        check(
          s.arm === arm && s.family === terrain && s.frames === 1501,
          `${terrain}/${arm} actual full timeline`,
          s,
        );
        check(
          await page
            .locator("#team-active")
            .innerText()
            .then((t) => t.includes("no ONNX")),
          `${terrain}/${arm} analytic provenance visible`,
        );
        check(
          (await page.locator(".team-belief canvas").count()) ===
            (arm === "independent" || arm === "sector" ? 2 : 1),
          `${terrain}/${arm} truthful belief count`,
        );
      }
    await open("&teamarm=shared&t=12&cam=ground");
    const first = await state();
    await page.reload();
    await page.waitForFunction(() => window.__team?.firstFrameMs > 0, null, {
      timeout: 180000,
    });
    check(
      (await state()).digest === first.digest,
      "fresh worker deterministic physical/evidence replay digest",
    );
    check(
      (await actualDigest()) === first.digest,
      "transport digest equals current numeric content",
    );
    for (const time of [12, 35, 65]) {
      await page.locator("#team-scrub").fill(String(time));
      await page.locator("#team-scrub").dispatchEvent("input");
      await page.evaluate(() =>
        document.getElementById("team-content").scrollTo(0, 0),
      );
      await settle();
      await page.evaluate(() => {
        for (const [id, on] of [
          ["team-cutaway", true],
          ["team-truth", false],
        ]) {
          const c = document.getElementById(id);
          if (c.checked !== on) c.click();
        }
      });
      await settle();
      const a = await page.locator("#sensor-A").screenshot(),
        b = await page.locator("#sensor-B").screenshot();
      writeFileSync(`${out}/sensor-A-t${time}-on.png`, a);
      writeFileSync(`${out}/sensor-B-t${time}-on.png`, b);
      await page.evaluate(() => {
        document.getElementById("team-cutaway").click();
        document.getElementById("team-truth").click();
      });
      await settle();
      const ao = await page.locator("#sensor-A").screenshot(),
        bo = await page.locator("#sensor-B").screenshot();
      writeFileSync(`${out}/sensor-A-t${time}-off.png`, ao);
      writeFileSync(`${out}/sensor-B-t${time}-off.png`, bo);
      pixels.push({
        time,
        A: { on: sha(a), off: sha(ao) },
        B: { on: sha(b), off: sha(bo) },
      });
      check(
        a.equals(ao) && b.equals(bo),
        `both actual sensors invariant under spectator cutaway/truth at${time}s`,
      );
      check(!a.equals(b), `A/B show distinct actual views at${time}s`);
    }
    check(
      (await actualDigest()) === first.digest,
      "render toggles do not mutate numerical transcript",
    );
    await page.locator("#team-focus").selectOption("B");
    await settle();
    check(
      (await state()).focus === "B",
      "spectator focus B independent of sensor cameras",
    );
    await page.locator("[data-camera=orbit]").click();
    await settle();
    const pane = page.locator("#spectator-pane");
    await pane.scrollIntoViewIfNeeded();
    await settle();
    const before = await pane.screenshot(),
      box = await pane.boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.55, {
      steps: 12,
    });
    await page.mouse.up();
    await settle();
    check(
      !before.equals(await pane.screenshot()),
      "manual Orbit drag changes overview",
    );
    await page.keyboard.press("2");
    await settle();
    check(
      (await state()).mode === "chase",
      "camera keyboard shortcut after camera button click",
    );
    await page.locator("#team-speed").selectOption("2");
    await page.locator("#team-scrub").fill("23");
    await page.locator("#team-scrub").dispatchEvent("input");
    await page.locator("#team-arm").selectOption("coordinated");
    await page.waitForFunction(
      () =>
        window.__team?.firstFrameMs > 0 && window.__team.arm === "coordinated",
      null,
      { timeout: 180000 },
    );
    const changed = await state();
    check(
      changed.time === 23 &&
        changed.speed === 2 &&
        changed.mode === "chase" &&
        changed.focus === "B",
      "policy change preserves replay/camera/focus state",
      changed,
    );
    await page.locator("#team-mission").selectOption("0");
    await page.waitForFunction(
      () => window.__team?.firstFrameMs > 0 && window.__team.missionIndex === 0,
      null,
      { timeout: 180000 },
    );
    check((await state()).time === 0, "new mission resets playback time");
    check(
      (await page.locator("#sensor-status-A").innerText()).includes(
        "no accepted fix",
      ),
      "uninitialised own tracker never labeled tracking",
    );
    await page.locator("#team-terrain").selectOption("original");
    await page.waitForFunction(
      () =>
        window.__team?.firstFrameMs > 0 && window.__team.family === "original",
      null,
      { timeout: 180000 },
    );
    check((await state()).time === 0, "terrain change resets playback time");
    for (const [width, height] of [
      [1440, 900],
      [1200, 900],
      [390, 844],
      [320, 568],
      [844, 390],
    ]) {
      await page.setViewportSize({ width, height });
      await open("&t=35&cam=ground&teamarm=shared");
      await page.evaluate(() =>
        document.getElementById("team-content").scrollTo(0, 0),
      );
      await page.screenshot({
        path: `${out}/layout-${width}x${height}-top.png`,
      });
      const geometry = await page.evaluate(() => {
        const rect = (id) => {
          const r = document.getElementById(id).getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        return {
          A: rect("sensor-A"),
          B: rect("sensor-B"),
          overview: rect("spectator-pane"),
          content: rect("team-content"),
          rail: (() => {
            const r = document
              .querySelector(".team-playback")
              .getBoundingClientRect();
            return { top: r.top, bottom: r.bottom };
          })(),
          scrollWidth: document.documentElement.scrollWidth,
          viewport: innerWidth,
        };
      });
      check(
        geometry.content.y + geometry.content.height <= geometry.rail.top + 1,
        `playback rail outside sensor scrollport ${width}x${height}`,
        geometry,
      );
      check(
        geometry.scrollWidth <= width + 1,
        `no horizontal overflow ${width}x${height}`,
        geometry,
      );
      check(
        Math.abs(geometry.A.width / geometry.A.height - 16 / 9) < 0.03 &&
          Math.abs(geometry.B.width / geometry.B.height - 16 / 9) < 0.03,
        `both true16:9 sensor panes ${width}x${height}`,
      );
      check(
        geometry.A.width * geometry.A.height +
          geometry.B.width * geometry.B.height >
          geometry.overview.width * geometry.overview.height,
        `combined sensor area dominates overview ${width}x${height}`,
      );
      if (width <= 700) {
        await page.locator("#team-config summary").click();
        await page.locator("#team-mission").scrollIntoViewIfNeeded();
        await page.locator("#team-mission").focus();
        check(
          await page.locator("#team-mission").evaluate((e) => {
            const r = e.getBoundingClientRect();
            return (
              document.elementFromPoint(
                r.x + r.width / 2,
                r.y + r.height / 2,
              ) === e
            );
          }),
          `mobile mission selector reachable ${width}x${height}`,
        );
        await page.locator("#team-config summary").click();
      }
      await page.locator("#sensor-B").scrollIntoViewIfNeeded();
      await settle();
      await page.screenshot({
        path: `${out}/layout-${width}x${height}-sensor-B.png`,
      });
      await page.locator("#team-method summary").click();
      await page.locator("#team-focus").selectOption("B");
      await page.locator("[data-camera=orbit]").click();
      await settle();
      check(
        (await state()).focus === "B" && (await state()).mode === "orbit",
        `scrolled controls usable ${width}x${height}`,
      );
      await page.locator("#team-play").click();
      await page.waitForTimeout(250);
      check((await state()).playing, `playback reachable ${width}x${height}`);
      await page.locator("#team-play").click();
      layouts.push({ width, height, geometry, state: await state() });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await open("&t=12&cam=ground&cutaway=0");
    check(
      (await page.locator("#cutaway-label").innerText()) === "CUTAWAY: OFF",
      "URL cutaway off label matches actual state",
    );
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: base,
      });
    await page.locator("#team-copy").click();
    check(
      (await page.evaluate(() => navigator.clipboard.readText())).includes(
        "mission=team",
      ),
      "copy replay link success",
    );
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: () => Promise.reject(Error("denied")) },
        configurable: true,
      }),
    );
    await page.locator("#team-copy").click();
    check(
      await page.locator("#team-link-fallback").isVisible(),
      "copy replay link denied fallback visible",
    );
    await page.goto(
      base + "?mission=team&duration=75&teamarm=shared&missionIndex=16",
    );
    await page.locator("#team-cancel").click();
    check(
      (await page.locator("#load-message").innerText()).includes("canceled"),
      "worker cancellation terminates pending computation",
    );
    await page.waitForTimeout(500);
    check(
      !(await page.evaluate(() => window.__team?.timeline)),
      "canceled worker cannot install stale timeline",
    );
    await page.locator("#team-retry").click();
    await page.waitForFunction(() => window.__team?.firstFrameMs > 0, null, {
      timeout: 180000,
    });
    check(true, "fresh worker retry succeeds");
    const fault = await browser.newPage();
    const faultErrors = [],
      faultRuntime = [];
    fault.on("pageerror", (e) => faultRuntime.push(String(e)));
    fault.on("console", (m) => {
      if (m.type() === "error") faultErrors.push(m.text());
    });
    await fault.route("**/*worker*.js", (r) => r.abort());
    await fault.goto(base + "?mission=team&duration=75");
    await fault.waitForFunction(
      () =>
        document.getElementById("team-retry") &&
        !document.getElementById("team-retry").hidden,
      null,
      { timeout: 30000 },
    );
    check(
      await fault.locator("#team-load").isVisible(),
      "worker load failure exposes retry",
    );
    await fault.unroute("**/*worker*.js");
    await fault.locator("#team-retry").click();
    await fault.waitForFunction(() => window.__team?.firstFrameMs > 0, null, {
      timeout: 180000,
    });
    check(true, "worker failure retry succeeds");
    faultEvidence.push({
      case: "intentional worker-load abort and retry",
      consoleErrors: faultErrors,
      runtimeErrors: faultRuntime,
    });
    check(
      faultRuntime.length === 0,
      "worker failure/retry has no uncaught runtime errors",
      faultRuntime,
    );
    await fault.close();
    const mismatch = await browser.newPage();
    mismatch.on("pageerror", (e) => errors.push(String(e)));
    await mismatch.addInitScript(() => {
      const Native = window.Worker;
      window.Worker = class extends Native {
        constructor(...args) {
          super(...args);
          this.addEventListener("message", (e) => {
            if (e.data?.type === "ready") e.data.fingerprint = "mismatch";
          });
        }
      };
    });
    await mismatch.goto(base + "?mission=team&duration=75");
    await mismatch.waitForFunction(
      () =>
        document
          .getElementById("load-message")
          ?.textContent.includes("fingerprint mismatch"),
      null,
      { timeout: 180000 },
    );
    check(
      !(await mismatch.evaluate(() => window.__team?.timeline)),
      "map fingerprint mismatch blocks rendering",
    );
    await mismatch.close();
    check(
      !requests.some((u) => /\.onnx|ort-wasm|\/models\//.test(u)),
      "team mode never requests ONNX/model assets",
    );
    check(
      !requests.some(
        (u) =>
          !u.startsWith(base) &&
          !u.startsWith("data:") &&
          !u.startsWith("blob:"),
      ),
      "no external app requests",
    );
  }
  if (process.env.BV_TEAM_SKIP_MOTION !== "1") {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const cam of ["cinematic", "chase", "ground", "orbit"]) {
      await open(
        `&teamarm=shared&t=0&cam=${cam}&speed=4&focus=${cam === "chase" ? "B" : "A"}`,
      );
      await page.locator("#team-play").click();
      for (const target of [15, 35, 55, 75]) {
        await page.waitForFunction((t) => window.__team.time >= t, target, {
          timeout: 180000,
        });
        await page.screenshot({ path: `${out}/motion-${cam}-${target}.png` });
      }
      const s = await state();
      motions.push(s);
      check(
        s.time === 75 && !s.playing,
        `${cam} full75s playback reaches stopped endpoint`,
        s,
      );
    }
  }
  check(errors.length === 0, "no runtime errors", errors);
  check(
    consoleErrors.length === 0,
    "no unexpected console errors",
    consoleErrors,
  );
} catch (error) {
  check(false, "browser suite completion", String(error));
} finally {
  persist();
  await browser.close();
  await server.httpServer.close();
}
if (checks.some((c) => !c.ok)) process.exitCode = 1;
