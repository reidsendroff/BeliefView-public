/** Actual view integration preflight. Development UI evidence, not a search-performance audit. */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
const out =
  process.env.BV_SHOT_DIR ?? "output/playwright/three-ui-final-controls";
const reportPath = process.env.BV_REPORT_PATH ?? `${out}/report.json`;
mkdirSync(dirname(reportPath), { recursive: true });
mkdirSync(out, { recursive: true });
const base = process.env.BV_BASE ?? "http://127.0.0.1:5174/";
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: false,
});
const page = await browser.newPage({ viewport: { width: 2507, height: 1361 } }),
  checks = [],
  errors = [],
  requests = [],
  timings = [],
  layouts = [],
  controlTransitions = [];
function observe(p) {
  p.on("pageerror", (e) => errors.push(String(e)));
  p.on("request", (r) => requests.push(r.url()));
}
observe(page);
const check = (ok, name, detail) => {
  checks.push({ ok: !!ok, name, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
};
const settle = async () => {
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await page.waitForTimeout(150);
};
let threePayload;
const sha = (b) => createHash("sha256").update(b).digest("hex");
try {
  for (const fleet of [3, 2]) {
    await page.goto(
      base +
        `?mission=team&fleet=${fleet}&duration=75&teamarm=coordinated&missionIndex=16&terrain=rich&paused=1&t=10&cam=ground`,
    );
    await page.waitForFunction(
      () =>
        window.__team?.firstFrameMs > 0 ||
        document.getElementById("load-title")?.textContent ===
          "Replay unavailable",
      null,
      { timeout: 180000 },
    );
    const state = await page.evaluate(() =>
      window.__team?.timeline
        ? {
            fleet: window.__team.fleet,
            policyVersion: window.__team.policyVersion,
            digest: window.__team.timelineDigest,
            computeMs: window.__team.computeMs,
            firstFrameMs: window.__team.firstFrameMs,
            bytes: window.__team.serializedBytes,
            ids: window.__team.timeline.frames[0].aircraft.map((a) => a.id),
            frames: window.__team.timeline.frames.length,
          }
        : { error: document.getElementById("load-message").textContent },
    );
    if (fleet === 3 && !state.error)
      threePayload = await page.evaluate(() => ({
        type: "ready",
        timeline: window.__team.timeline,
        fingerprint: window.__team.mapFingerprint,
        timelineDigest: window.__team.timelineDigest,
        computeMs: window.__team.computeMs,
        serializedBytes: window.__team.serializedBytes,
      }));
    timings.push(state);
    check(
      state.fleet === fleet && state.ids?.length === fleet,
      `fleet${fleet}actualtimeline`,
      state,
    );
    if (state.error) throw Error(state.error);
    await settle();
    for (const [width, height] of [
      [1280, 720],
      [1440, 900],
      [1920, 1080],
      [2507, 1361],
      [2560, 1440],
      [320, 568],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() =>
        document.getElementById("team-content").scrollTo(0, 0),
      );
      await settle();
      const r = await page.evaluate(() => {
        const rect = (e) => {
          const r = e.getBoundingClientRect();
          return {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            bottom: r.bottom,
            right: r.right,
          };
        };
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          root: rect(document.getElementById("team-content")),
          spectator: rect(document.getElementById("spectator-pane")),
          sensors: [...document.querySelectorAll(".team-sensor")].map(rect),
          gps: [...document.querySelectorAll(".team-gps")].map(rect),
          rail: rect(document.querySelector(".team-playback")),
        };
      });
      layouts.push({ fleet, width, height, ...r });
      check(
        !r.overflow &&
          (width < 701 ||
            (r.sensors.every(
              (s) =>
                s.bottom <= r.rail.y &&
                Math.abs(s.width / s.height - 16 / 9) < 0.001 &&
                r.spectator.width * r.spectator.height < s.width * s.height,
            ) &&
              r.gps.every((g) => g.bottom <= r.rail.y))),
        `fleet${fleet}layout${width}x${height}`,
        r,
      );
      await page.screenshot({
        path: `${out}/fleet${fleet}-${width}x${height}.png`,
      });
    }
    await page.setViewportSize({ width: 2507, height: 1361 });
    await page.evaluate(() =>
      document.getElementById("team-content").scrollTo(0, 0),
    );
    await settle();
    const ids = fleet === 3 ? ["A", "B", "C"] : ["A", "B"];
    await page.evaluate(()=>{const e=document.getElementById("team-overlay-annotations");if(e.checked)e.click();});
    await settle();
    const before = [];
    for (const id of ids)
      before.push(await page.locator("#sensor-" + id).screenshot());
    await page.evaluate(() => {
      document.getElementById("team-cutaway").click();
      document.getElementById("team-truth").click();
      document.getElementById("team-frustum").click();
    });
    await settle();
    for (const [i, id] of ids.entries()) {
      const after = await page.locator("#sensor-" + id).screenshot();
      check(
        before[i].equals(after),
        `fleet${fleet}sensor${id}spectatorisolation`,
        { before: sha(before[i]), after: sha(after) },
      );
      writeFileSync(`${out}/fleet${fleet}-sensor${id}.png`, after);
    }
    check(
      new Set(before.map(sha)).size === fleet,
      `fleet${fleet}distinctactualsensorimages`,
    );
    await page.selectOption("#team-focus", ids.at(-1));
    await settle();
    for (const [i, id] of ids.entries())
      check(
        before[i].equals(await page.locator("#sensor-" + id).screenshot()),
        `fleet${fleet}sensor${id}focusisolation`,
      );
    check(
      (await page.evaluate(() => window.__team.timelineDigest)) ===
        state.digest,
      `fleet${fleet}replaydigestunchanged`,
    );
    await page.setViewportSize({ width: 1280, height: 720 });
    await settle();
    await page.locator("#team-method-open").click();
    check(
      await page
        .locator("#team-method")
        .evaluate((e) => e.open && e.getBoundingClientRect().bottom > 0),
      `fleet${fleet}methodoneaction`,
    );
    await page.keyboard.press("Escape");
    check(
      !(await page
        .locator("#team-evidence-panel")
        .evaluate((e) => e.classList.contains("is-open"))),
      `fleet${fleet}drawerEscape`,
    );
  }
  // Exercise real controls with actual workers. No full-motion playback is duplicated here.
  const stateNow = () =>
    page.evaluate(() => ({
      fleet: window.__team.fleet,
      arm: window.__team.arm,
      family: window.__team.family,
      missionIndex: window.__team.missionIndex,
      duration: window.__team.duration,
      time: window.__team.time,
      playing: window.__team.playing,
      speed: window.__team.speed,
      mode: window.__team.mode,
      focus: window.__team.focus,
      digest: window.__team.timelineDigest,
      ids: window.__team.timeline.frames[0].aircraft.map((a) => a.id),
      frames: window.__team.timeline.frames.length,
      computeMs: window.__team.computeMs,
      firstFrameMs: window.__team.firstFrameMs,
    }));
  async function ready() {
    await page.waitForFunction(
      () =>
        window.__team?.firstFrameMs > 0 ||
        document.getElementById("load-title")?.textContent ===
          "Replay unavailable",
      null,
      { timeout: 180000 },
    );
    const failure = await page.locator("#load-title").textContent();
    if (failure === "Replay unavailable")
      throw Error(await page.locator("#load-message").textContent());
    await settle();
    const state = await stateNow();
    controlTransitions.push(state);
    return state;
  }
  async function configSelect(id, key, value) {
    if (!(await page.locator("#team-config").evaluate((e) => e.open)))
      await page.locator("#team-config summary").click();
    await Promise.all([
      page.waitForURL((u) => u.searchParams.get(key) === value),
      page.locator("#" + id).selectOption(value),
    ]);
    return ready();
  }
  async function seek(t) {
    await page.locator("#team-scrub").evaluate((e, t) => {
      e.value = String(t);
      e.dispatchEvent(new Event("input", { bubbles: true }));
    }, t);
    await settle();
    return stateNow();
  }
  let control = await configSelect("team-fleet", "fleet", "3");
  check(
    control.fleet === 3 &&
      control.ids.join(",") === "A,B,C" &&
      control.time === 0 &&
      !control.playing,
    "actual fleet selector 2 to 3 resets and computes cohort",
    control,
  );
  await page.selectOption("#team-focus", "C");
  await settle();
  check(
    (await stateNow()).focus === "C" &&
      new URL(page.url()).searchParams.get("focus") === "C",
    "Drone C spectator focus serializes",
  );
  await seek(12);
  await page.locator("#team-speed").selectOption("2");
  await page.locator("#spectator-pane").click({ position: { x: 30, y: 40 } });
  await page.keyboard.press("2");
  await settle();
  check(
    (await stateNow()).mode === "chase",
    "camera digit shortcut selects Chase",
  );
  await page.keyboard.press("Space");
  await page.waitForFunction(
    () => window.__team.playing && window.__team.time > 12.1,
  );
  await page.keyboard.press("Space");
  await settle();
  check(
    !(await stateNow()).playing && (await stateNow()).time > 12.1,
    "Space starts and pauses actual playback",
  );
  await page.locator("#team-restart").click();
  await page.waitForFunction(
    () => window.__team.playing && window.__team.time < 2,
  );
  await page.locator("#team-play").click();
  await seek(12);
  check(
    (await stateNow()).time === 12 && !(await stateNow()).playing,
    "restart and scrub restore exact paused time",
  );
  await page.locator("#team-method-open").focus();
  await page.keyboard.press("Enter");
  check(
    await page.evaluate(
      () =>
        document.getElementById("team-method").open &&
        document.activeElement.id === "team-method",
    ),
    "Method opens by keyboard and receives focus",
  );
  await page.keyboard.press("Escape");
  check(
    await page.evaluate(() => document.activeElement.id === "team-method-open"),
    "Method Escape restores opener focus",
  );
  await page.locator("#team-evidence-toggle").focus();
  await page.keyboard.press("Enter");
  check(
    await page
      .locator("#team-evidence-panel")
      .evaluate((e) => e.classList.contains("is-open")),
    "Evidence drawer opens by keyboard",
  );
  await page.keyboard.press("Escape");
  check(
    await page.evaluate(
      () => document.activeElement.id === "team-evidence-toggle",
    ),
    "Evidence Escape restores opener focus",
  );
  control = await configSelect("team-arm", "teamarm", "shared");
  check(
    control.fleet === 3 &&
      control.arm === "shared" &&
      control.time === 12 &&
      !control.playing &&
      control.mode === "chase" &&
      control.speed === 2 &&
      control.focus === "C",
    "policy change preserves fleet time camera speed and focus",
    control,
  );
  control = await configSelect("team-mission", "missionIndex", "17");
  check(
    control.missionIndex === 17 && control.time === 0 && !control.playing,
    "mission change resets time and recomputes",
    control,
  );
  await seek(8);
  control = await configSelect("team-terrain", "terrain", "original");
  check(
    control.family === "original" && control.time === 0 && !control.playing,
    "terrain change resets time and recomputes",
    control,
  );
  for (const duration of [180, 300, 75]) {
    await seek(5);
    control = await configSelect("team-duration", "duration", String(duration));
    check(
      control.duration === duration &&
        control.frames === Math.round(duration / 0.05) + 1 &&
        control.time === 0 &&
        !control.playing,
      `duration ${duration} computes actual horizon and resets`,
      control,
    );
    const end = await seek(duration);
    check(
      end.time === duration && !end.playing,
      `duration ${duration} endpoint is renderable and paused`,
      end,
    );
  }
  await page.setViewportSize({ width: 320, height: 568 });
  await settle();
  for (const id of ["A", "B", "C"]) {
    await page.locator("#sensor-" + id).scrollIntoViewIfNeeded();
    await settle();
    const visible = await page.locator("#sensor-" + id).evaluate((e) => {
      const r = e.getBoundingClientRect(),
        p = document.getElementById("team-content").getBoundingClientRect(),
        rail = document.querySelector(".team-playback").getBoundingClientRect();
      const x = r.x + r.width / 2,
        y = r.y + r.height / 2;
      return (
        r.width > 0 &&
        r.top >= p.top - 1 &&
        r.bottom <= Math.min(p.bottom, rail.top) + 1 &&
        e.contains(document.elementFromPoint(x, y))
      );
    });
    check(visible, `mobile320 sensor ${id} scrolls into usable viewport`);
    await page.screenshot({ path: `${out}/mobile320-drone-${id}.png` });
  }
  await page.locator("#team-method-open").click();
  check(
    await page.locator("#team-method").evaluate((e) => {
      const r = e.getBoundingClientRect();
      return e.open && r.top < innerHeight && r.bottom > 0;
    }),
    "mobile320 Method and disclosures reachable",
  );
  await page.locator("#team-config summary").click();
  for (const id of [
    "team-fleet",
    "team-arm",
    "team-terrain",
    "team-mission",
    "team-duration",
  ]) {
    await page.locator("#" + id).scrollIntoViewIfNeeded();
    check(
      await page.locator("#" + id).evaluate((e) => {
        const r = e.getBoundingClientRect();
        return (
          document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === e
        );
      }),
      `mobile320 ${id} is reachable`,
    );
  }
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "mobile320 no horizontal page overflow",
  );
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => {
    document.getElementById("team-content").scrollTo(0, 0);
    document.getElementById("team-config").open = false;
  });
  await settle();
  control = await configSelect("team-fleet", "fleet", "2");
  check(
    control.fleet === 2 &&
      control.ids.join(",") === "A,B" &&
      control.focus === "A" &&
      control.time === 0 &&
      !control.playing &&
      (await page.locator("#sensor-C").count()) === 0,
    "actual fleet selector 3 to 2 removes C and clamps focus A",
    control,
  );
  await seek(12);
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  await page.locator("#team-copy").click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const replayUrl = new URL(copied);
  check(
    replayUrl.searchParams.get("fleet") === "2" &&
      replayUrl.searchParams.get("duration") === "75" &&
      replayUrl.searchParams.get("focus") === "A" &&
      replayUrl.searchParams.get("t") === "12.00" &&
      replayUrl.searchParams.get("speed") === "2" &&
      replayUrl.searchParams.get("cam") === "chase",
    "copied replay URL includes all compatible controls",
    copied,
  );
  const beforeReload = await stateNow();
  await page.reload();
  control = await ready();
  check(
    control.digest === beforeReload.digest &&
      control.fleet === 2 &&
      control.time === 12 &&
      control.mode === "chase" &&
      control.speed === 2,
    "copied settings reload with identical numeric replay",
    control,
  );
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: () => Promise.reject(new Error("Synthetic permission denial")),
    }),
  );
  await page.locator("#team-copy").click();
  check(
    await page
      .locator("#team-link-fallback")
      .evaluate(
        (e) =>
          !e.hidden &&
          e.selectionStart === 0 &&
          e.selectionEnd === e.value.length &&
          new URL(e.value).searchParams.get("fleet") === "2",
      ),
    "copy denial exposes selected fallback replay link",
  );

  // Replay an already recorded valid payload to isolate asynchronous transport from CPU simulation.
  const stale = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  observe(stale);
  await stale.addInitScript((payload) => {
    const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    let calls = 0,
      workers = 0;
    crypto.subtle.digest = async (...args) => {
      calls++;
      if (calls === 1) {
        window.__oldValidationWaiting = true;
        await new Promise(
          (resolve) => (window.__releaseOldValidation = resolve),
        );
      }
      return nativeDigest(...args);
    };
    window.Worker = class {
      constructor() {
        this.number = ++workers;
      }
      terminate() {
        this.terminated = true;
      }
      postMessage() {
        const data = structuredClone(payload);
        if (this.number === 1) data.fingerprint = "invalid-old-map";
        queueMicrotask(() => this.onmessage?.({ data }));
      }
    };
  }, threePayload);
  await stale.goto(
    base +
      "?mission=team&fleet=3&duration=75&teamarm=coordinated&missionIndex=16&terrain=rich&paused=1",
  );
  await stale.waitForFunction(() => window.__oldValidationWaiting);
  await stale.locator("#team-method-open").click();
  check(
    await stale.locator("dialog[open]").isVisible(),
    "method accessible during worker validation",
  );
  await stale.locator("dialog button").click();
  await stale.locator("#team-cancel").click();
  await stale.locator("#team-retry").click();
  await stale.waitForFunction(() => window.__team?.firstFrameMs > 0, null, {
    timeout: 30000,
  });
  await stale.evaluate(() => window.__releaseOldValidation());
  await stale.waitForTimeout(200);
  check(
    await stale.evaluate(
      () =>
        window.__team?.timeline?.fleet === 3 &&
        document.getElementById("team-load").hidden,
    ),
    "invalid delayed old payload cannot terminate replacement replay",
  );
  await stale.close();
  for (const kind of [
    "missingC",
    "duplicateC",
    "nonfiniteC",
    "wrongArm",
    "wrongVersion",
    "bodyNaN",
    "bodyPosture",
    "bodyVersion",
    "bodyGrounding",
    "worldGeometryHash",
  ]) {
    const fault = await browser.newPage();
    observe(fault);
    await fault.addInitScript(
      ({ payload, kind }) => {
        window.Worker = class {
          terminate() {}
          async postMessage() {
            const data = structuredClone(payload),
              t = data.timeline;
            if (kind === "missingC") t.frames[100].aircraft.pop();
            if (kind === "duplicateC") t.frames[100].aircraft[2].id = "B";
            if (kind === "nonfiniteC")
              t.frames[100].aircraft[2].state.camYaw = NaN;
            if (kind === "wrongArm") t.diagnostics.arm = "shared";
            if (kind === "wrongVersion") t.policyVersion = "invalid-version";
            if(kind==="bodyNaN")t.frames[100].subject.body.heading=NaN;
            if(kind==="bodyPosture")t.frames[100].subject.body.posture.progress=1.5;
            if(kind==="bodyVersion")t.frames[100].subject.bodyVersion="wrong-body-version";
            if(kind==="bodyGrounding"){t.frames[100].subject.body.root.y+=100;t.frames[100].subject.y+=100;}
            if(kind==="worldGeometryHash")data.fingerprint="wrong-public-geometry-hash";

            const bytes = new TextEncoder().encode(
              JSON.stringify({
                fleet: t.fleet,
                policyVersion: t.policyVersion,
                frames: t.frames,
                decisions: t.decisions,
                beliefEpochs: t.beliefEpochs,
                metrics: t.metrics,
              }),
            );
            data.timelineDigest = [
              ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            ]
              .map((x) => x.toString(16).padStart(2, "0"))
              .join("");
            this.onmessage?.({ data });
          }
        };
      },
      { payload: threePayload, kind },
    );
    await fault.goto(
      base +
        "?mission=team&fleet=3&duration=75&teamarm=coordinated&missionIndex=16&terrain=rich&paused=1",
    );
    await fault.waitForFunction(
      () =>
        document.getElementById("load-title")?.textContent ===
        "Replay unavailable",
      null,
      { timeout: 30000 },
    );
    check(
      await fault.evaluate(
        kind =>
          !window.__team?.timeline &&
          document
            .getElementById("load-message")
            .textContent.includes(kind==="worldGeometryHash"?"fingerprint mismatch":kind==="bodyGrounding"?"grounding mismatch":kind.startsWith("body")?"body contract mismatch":"cohort mismatch"),
        kind,
      ),
      `matching-digest ${kind} rejected before rendering`,
    );
    await fault.close();
  }
  check(errors.length === 0, "no runtimeerrors", errors);
  check(
    !requests.some(
      (u) =>
        !u.startsWith(base) && !u.startsWith("blob:") && !u.startsWith("data:"),
    ),
    "no external requests",
  );
  check(
    !requests.some((u) => /\.onnx|ort-wasm|\/models\//.test(u)),
    "no ONNX model requests",
  );
} catch (error) {
  check(false, "suitecomplete", String(error));
} finally {
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        role: "Actual browser controls, layout and fault checks; development only; no numerical reliability claim",
        checks,
        errors,
        timings,
        layouts,
        controlTransitions,
        requests,
      },
      null,
      2,
    ),
  );
  await browser.close();
}
if (checks.some((c) => !c.ok)) process.exitCode = 1;
