/** Presentation-only current replay preflight; not new-world numerical evidence. */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const out =
  process.env.BV_SHOT_DIR ?? "output/playwright/three-analysis-preflight";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: false,
});
const page = await browser.newPage({ viewport: { width: 2507, height: 1361 } }),
  layouts = [],
  checks = [],
  errors = [],
  requests = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("request", (r) => requests.push(r.url()));
const settle = async () => {
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await page.waitForTimeout(250);
};
const sha = (b) => createHash("sha256").update(b).digest("hex");
try {
  for (const fleet of [3, 2]) {
    await page.goto(
      `http://127.0.0.1:5174/?mission=team&fleet=${fleet}&teamarm=coordinated&missionIndex=16&duration=75&paused=1&t=10&cam=chase`,
    );
    await page.waitForFunction(() => window.__team?.timelineDigest, {
      timeout: 120000,
    });
    await settle();
    for (const [width, height] of [
      [1280, 720],
      [1366, 768],
      [1440, 900],
      [1920, 1080],
      [2507, 1361],
      [2560, 1440],
      [1598, 900],
      [1599, 900],
      [1600, 900],
      [1440, 819],
      [1440, 820],
      [1440, 821],
      [320, 844],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await settle();
      const rects = await page.evaluate(() => {
        const box = (id) => {
          const r = (
            id === "team-playback"
              ? document.querySelector(".team-playback")
              : document.getElementById(id)
          ).getBoundingClientRect();
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
          a: box("sensor-A"),
          b: box("sensor-B"),
          c: document.getElementById("sensor-C") ? box("sensor-C") : null,
          overview: box("spectator-pane"),
          gps: [...document.querySelectorAll(".team-gps")].map((e) => ({
            y: e.getBoundingClientRect().y,
            bottom: e.getBoundingClientRect().bottom,
          })),
          rail: box("team-playback"),
          scrollWidth: document.documentElement.scrollWidth,
        };
      });
      layouts.push({ fleet, width, height, ...rects });
      const target = {
        1280: 400,
        1366: 424,
        1440: 480,
        1920: 640,
        2507: 880,
        2560: 920,
      }[width];
      if (target && [720, 768, 900, 1080, 1361, 1440].includes(height))
        checks.push({
          name: `${fleet} fleet ${width}x${height} sensor minimum`,
          ok:
            rects.a.width >= target - 1 &&
            rects.b.width >= target - 1 &&
            (!rects.c || rects.c.width >= target - 1),
          target,
          observed: rects.a.width,
        });
      checks.push({
        name: `${fleet} fleet ${width}x${height} no horizontal overflow`,
        ok: rects.scrollWidth <= width + 1,
      });
      if (width >= 1280)
        checks.push({
          name: `${fleet} fleet ${width}x${height} views fit`,
          ok:
            [rects.a, rects.b, rects.c, rects.overview]
              .filter(Boolean)
              .every(
                (r) =>
                  r.bottom <= rects.rail.y + 1 &&
                  r.x >= 0 &&
                  r.right <= width + 1,
              ) && rects.gps.every((r) => r.bottom <= rects.rail.y + 1),
        });
      await page.screenshot({
        path: `${out}/fleet${fleet}-${width}x${height}.png`,
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await settle();
    await page.evaluate(() => {
      document.getElementById("team-overlay-annotations").click();
    });
    await settle();
    const before = await Promise.all(
      Array.from({ length: fleet }, (_, i) =>
        page
          .locator("#sensor-" + String.fromCharCode(65 + i))
          .screenshot()
          .then(sha),
      ),
    );
    const digest = await page.evaluate(() => window.__team.timelineDigest);
    for (const key of ["mass", "predict", "plans", "marks", "fill"]) {
      await page.evaluate(
        (key) => document.getElementById("team-overlay-" + key).click(),
        key,
      );
      await settle();
      const after = await Promise.all(
        Array.from({ length: fleet }, (_, i) =>
          page
            .locator("#sensor-" + String.fromCharCode(65 + i))
            .screenshot()
            .then(sha),
        ),
      );
      checks.push({
        name: `${fleet} raw sensor isolation: ${key}`,
        ok: JSON.stringify(before) === JSON.stringify(after),
        before,
        after,
      });
      await page.evaluate(
        (key) => document.getElementById("team-overlay-" + key).click(),
        key,
      );
      await settle();
    }
    await page.evaluate(() =>
      document.getElementById("team-overlay-annotations").click(),
    );
    await settle();
    const annotationCases = await page.evaluate(async () => {
      const THREE = await import("/node_modules/three/build/three.module.js");
      const scenario =
        window.__team.fleet === 3
          ? await import("/src/team/threeScenario.ts")
          : await import("/src/team/scenario.ts");
      const world = (
        scenario.buildThreePublicScenario ?? scenario.buildPublicScenario
      )(220000 + window.__team.missionIndex, window.__team.family).world;
      const {TeamMap}=await import('/src/team/map.ts');
      const {ThreeGeometry}=await import('/src/team/threeGeometry.ts');
      const expectedMap=new TeamMap(world,window.__team.fleet===3?new ThreeGeometry(world):undefined);
      const cells=expectedMap.cells.map(c=>({x:c.x,z:c.z,minX:c.minX,maxX:c.maxX,minZ:c.minZ,maxZ:c.maxZ,valid:c.valid}));
      if(JSON.stringify(cells)!==JSON.stringify(window.__team.presentationCells))throw Error('Presentation cells differ from runtime map contract');
      const cases = [];
      for (const id of window.__team.fleet === 3 ? ["A", "B", "C"] : ["A", "B"])
        for (const kind of ["report", "prediction"]) {
          const frame = window.__team.timeline.frames.find((f) => {
            const a = f.aircraft.find((a) => a.id === id);
            return kind === "report"
              ? a.observation
              : !a.observation && a.ownTrack.initialised;
          });
          if (!frame) {
            cases.push({ id, kind, found: false });
            continue;
          }
          const slider = document.getElementById("team-scrub");
          slider.value = String(frame.t);
          slider.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          );
          const d = frame.aircraft.find((a) => a.id === id),
            o = d.observation ?? d.ownTrack,
            c = new THREE.PerspectiveCamera(
              (2 * Math.atan(Math.tan(Math.PI / 5) / (16 / 9)) * 180) / Math.PI,
              16 / 9,
              0.3,
              260,
            );
          const f = {
            x: Math.sin(d.state.camYaw) * Math.cos(d.state.camPitch),
            y: Math.sin(d.state.camPitch),
            z: Math.cos(d.state.camYaw) * Math.cos(d.state.camPitch),
          };
          c.position.set(d.state.pos.x, d.state.pos.y, d.state.pos.z);
          c.lookAt(c.position.x + f.x, c.position.y + f.y, c.position.z + f.z);
          c.updateMatrixWorld();
          const p = new THREE.Vector3(
              o.x,
              world.heightAt(o.x, o.z) + 1,
              o.z,
            ).project(c),
            expectedVisible =
              p.z >= -1 && p.z <= 1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1,
            marker = document.getElementById("annotation-" + id);
          cases.push({
            id,
            kind,
            found: true,
            time: frame.t,
            expectedVisible,
            hidden: marker.hidden,
            source: marker.dataset.source,
            label: marker.textContent,
            x: parseFloat(marker.style.left) / 100,
            y: parseFloat(marker.style.top) / 100,
            expectedX: (p.x + 1) / 2,
            expectedY: (1 - p.y) / 2,
          });
        }
      return cases;
    });
    checks.push({
      name: `${fleet} real own-report DOM projections`,
      ok:
        annotationCases.some((c) => c.found) &&
        annotationCases.every(
          (c) =>
            !c.found ||
            (c.hidden === !c.expectedVisible &&
              (!c.expectedVisible ||
                (c.source === c.id &&
                  c.label ===
                    (c.kind === "report"
                      ? "Own noisy report"
                      : "Predicted position / no fix") &&
                  Math.abs(c.x - c.expectedX) < 1e-5 &&
                  Math.abs(c.y - c.expectedY) < 1e-5))),
        ),
      detail: annotationCases,
    });
    await page.evaluate(() => {
      const e = document.getElementById("team-scrub");
      e.value = "0";
      e.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    checks.push({
      name: `${fleet} backward seek never displays future mass epoch`,
      ok: await page.evaluate(
        () =>
          window.__team.analysisRecord.epoch === null ||
          window.__team.analysisRecord.epoch <= window.__team.time,
      ),
    });
    checks.push({
      name: `${fleet} digest/layers`,
      ok: await page.evaluate(
        (d) =>
          window.__team.timelineDigest === d &&
          window.__team.overlayLayersValid,
        digest,
      ),
    });
  }
  await page.goto(
    "http://127.0.0.1:5174/?mission=team&fleet=3&teamarm=independent&missionIndex=16&duration=75&paused=1&t=20&cam=chase",
  );
  await page.waitForFunction(() => window.__team?.timelineDigest, {
    timeout: 120000,
  });
  await settle();
  for (const id of ["A", "B", "C"]) {
    await page.selectOption("#team-focus", id);
    await settle();
    const detail = await page.evaluate(() => {
      const d = window.__team,
        epoch = [...d.timeline.beliefEpochs]
          .reverse()
          .find((e) => e.t <= d.time),
        p = epoch?.sensors.find((s) => s.id === d.focus)?.probability;
      const expected = [];
      let mass = 0;
      if (p)
        for (const v of p
          .map((p, k) => ({ p, k }))
          .filter((v) => v.p > 0)
          .sort((a, b) => b.p - a.p || a.k - b.k)) {
          expected.push(v.k);
          mass += v.p;
          if (mass >= 0.95) break;
        }
      return { focus: d.focus, record: d.analysisRecord, expected };
    });
    checks.push({
      name: `independent focus${id} actual mass source`,
      ok:
        detail.record.source === id &&
        JSON.stringify(detail.expected) ===
          JSON.stringify(detail.record.selectedCells),
      detail,
    });
  }
  checks.push({
    name: "no external or ONNX requests",
    ok:
      requests.every(
        (u) =>
          u.startsWith("http://127.0.0.1:5174/") ||
          u.startsWith("ws://127.0.0.1:5174/") ||
          u.startsWith("data:") ||
          u.startsWith("blob:"),
      ) && !requests.some((u) => /onnx|ort-wasm/i.test(u)),
  });
} catch (e) {
  errors.push(String(e));
} finally {
  await browser.close();
  writeFileSync(
    `${out}/report.json`,
    JSON.stringify({ checks, layouts, errors, requests }, null, 2),
  );
  console.log(JSON.stringify({ checks, layouts, errors }));
}
