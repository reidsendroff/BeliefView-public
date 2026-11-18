/** Actual production-browser evidence for physical rich terrain, active policy and separate camera panes. */
import { chromium } from "playwright-core";
import { preview } from "vite";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const outDir = `${root}output/playwright/intelligence`;
mkdirSync(outDir, { recursive: true });
const server = await preview({
  root,
  preview: { port: 4182, strictPort: true, host: "127.0.0.1" },
});
const base = "http://127.0.0.1:4182/";
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: false,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const checks = [],
  errors = [],
  consoleErrors = [],
  requests = [],
  examples = [],
  layouts = [],
  motions = [],
  pixels = [];
const check = (ok, message, detail) => {
  checks.push({ ok: !!ok, message, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${message}`);
};
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("request", (r) => requests.push(r.url()));
const state = () => page.evaluate(() => window.__demo3d.state());
async function open(q) {
  await page.goto(base + q);
  await page.waitForFunction(
    () => window.__demo3d?.performance().firstFrameMs > 0,
    null,
    { timeout: 180000 },
  );
  await page.waitForTimeout(700);
}
const info = () =>
  page.evaluate(() => ({
    state: window.__demo3d.state(),
    digest: window.__demo3d.ml.framesDigest(),
    active: window.__demo3d.ml.active,
    model: window.__demo3d.ml.info(),
    inference: window.__demo3d.ml.stats(),
    performance: window.__demo3d.performance(),
    guidance: window.__demo3d.ml.guidance(),
  }));
try {
  if (process.env.BV_MOTION_ONLY !== "1") {
    for (const terrain of ["original", "rich"])
      for (const arm of ["kalman", "baseline", "active"]) {
        const q = `?terrain=${terrain}&guidance=${arm === "kalman" ? "kalman" : "ml"}&policy=${arm}&paused=1&t=12&cam=ground`;
        await open(q);
        const a = await info();
        await page.screenshot({ path: `${outDir}/${terrain}-${arm}.png` });
        await open(q);
        const b = await info();
        examples.push({ terrain, arm, ...a });
        check(
          a.digest === b.digest,
          `${terrain}/${arm}: deterministic full trajectory`,
        );
        check(
          a.active === (arm === "kalman" ? "kalman" : "ml"),
          `${terrain}/${arm}: active guidance truthful`,
        );
      }
    const richKal = examples.find(
      (e) => e.terrain === "rich" && e.arm === "kalman",
    );
    await page.route("**/missing.json", (r) =>
      r.fulfill({ status: 404, body: "missing" }),
    );
    await open(
      "?terrain=rich&guidance=ml&policy=active&mlManifest=/missing.json&paused=1",
    );
    check(
      (await info()).digest === richKal.digest &&
        (await page.locator("#ml-active").innerText()).includes("FALLBACK"),
      "missing model preserves rich world and uses explicit Kalman fallback",
    );
    await page.unroute("**/missing.json");
    await page.route("**/model.onnx", async (r) => {
      const response = await r.fetch(),
        body = Buffer.from(await response.body());
      body[body.length - 1] ^= 1;
      await r.fulfill({ response, body });
    });
    await open("?terrain=rich&guidance=ml&policy=active&paused=1");
    check(
      (await info()).digest === richKal.digest &&
        (await info()).active === "kalman",
      "corrupt model preserves rich-world Kalman fallback",
    );
    await page.unroute("**/model.onnx");
    await open(
      "?terrain=rich&guidance=ml&policy=active&paused=1&t=35&cam=ground",
    );
    await page.locator("#inspector > summary").click();
    await page.locator("#controls > summary").click();
    for (const t of [12, 35, 65]) {
      await page.evaluate((t) => window.__demo3d.seek(t), t);
      await page.locator("#t-see").evaluate(el => { if (!el.checked) el.click(); window.scrollTo(0,0); });
      await page.waitForTimeout(1000);
      const on = await page.locator("#inset").screenshot();
      const box = await page.locator("#spectator-pane").boundingBox();
      const crop = {
        x: box.x + 2,
        y: box.y + 32,
        width: box.width - 4,
        height: box.height - 34,
      };
      const mainOn = await page.screenshot({ clip: crop });
      const s = await state();
      await page.locator("#t-see").evaluate(el => { if (el.checked) el.click(); window.scrollTo(0,0); });
      await page.waitForTimeout(1000);
      const off = await page.locator("#inset").screenshot();
      const mainOff = await page.screenshot({ clip: crop });
      const hash = (b) => createHash("sha256").update(b).digest("hex");
      pixels.push({
        t,
        on: hash(on),
        off: hash(off),
        cutawayCount: s.cutawayCount,
        spectatorOn: hash(mainOn),
        spectatorOff: hash(mainOff),
      });
      check(
        on.equals(off),
        `t${t}: sensor pixels identical with spectator cutaway on/off`,
      );
      check(
        !mainOn.equals(mainOff),
        `t${t}: spectator cutaway changes rendered obstruction`,
      );
      writeFileSync(`${outDir}/sensor-t${t}.png`, on);
      writeFileSync(`${outDir}/sensor-opaque-t${t}.png`, off);
      check(await page.evaluate(() => scrollY === 0), `t${t}: isolation keeps fixed viewport scroll`);
      writeFileSync(`${outDir}/spectator-cutaway-t${t}.png`, mainOn);
      writeFileSync(`${outDir}/spectator-opaque-t${t}.png`, mainOff);
    }
    await page.locator("#t-see").evaluate(el => { if (!el.checked) el.click(); window.scrollTo(0,0); });
    await page.locator('#cams button[data-cam="orbit"]').click();
    const orbitBox = await page.locator("#spectator-pane").boundingBox();
    const orbitBefore = await page.locator("#spectator-pane").screenshot();
    await page.mouse.move(
      orbitBox.x + orbitBox.width * 0.5,
      orbitBox.y + orbitBox.height * 0.5,
    );
    await page.mouse.down();
    await page.mouse.move(
      orbitBox.x + orbitBox.width * 0.7,
      orbitBox.y + orbitBox.height * 0.6,
      { steps: 12 },
    );
    await page.mouse.up();
    await page.waitForTimeout(300);
    check(
      !(await page.locator("#spectator-pane").screenshot()).equals(orbitBefore),
      "manual Orbit drag changes spectator camera",
    );
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
      [390, 667],
      [320, 568],
      [844, 390],
    ]) {
      await page.setViewportSize({ width, height });
      await open("?terrain=rich&guidance=ml&policy=active&paused=1&t=20");
      const geometry = await page.evaluate(() =>
        Object.fromEntries(
          [
            "inset",
            "spectator-pane",
            "status",
            "inspector",
            "camera-toolbar",
            "timeline",
            "ml-active",
          ].map((id) => {
            const r = document.getElementById(id).getBoundingClientRect();
            return [
              id,
              {
                x: r.x,
                y: r.y,
                w: r.width,
                h: r.height,
                right: r.right,
                bottom: r.bottom,
              },
            ];
          }),
        ),
      );
      check(geometry["ml-active"].y >= 0 && geometry["ml-active"].bottom < height - 100, `${width}x${height}: active/fallback policy visible above camera panes`);
      check(
        Math.abs(geometry.inset.w / geometry.inset.h - 16 / 9) < 0.01,
        `${width}x${height}: sensor projection remains16:9`,
      );
      check(
        geometry.inset.w >= width * (width < 600 ? 0.9 : 0.4),
        `${width}x${height}: large sensor pane`,
      );
      check(
        geometry.inset.x >= 0 && geometry.inset.right <= width + 0.5,
        `${width}x${height}: sensor fits width`,
      );
      const overlaps = (a, b) =>
        Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x)) *
        Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
      check(
        overlaps(geometry.inset, geometry["spectator-pane"]) < 1,
        `${width}x${height}: camera panes separate`,
      );
      await page.screenshot({
        path: `${outDir}/layout-${width}x${height}.png`,
      });
      await page.locator("#inspector > summary").click();
      await page.locator("#model-details > summary").click();
      await page.locator("#domain-note").scrollIntoViewIfNeeded();
      check(
        await page.locator("#domain-note").isVisible(),
        `${width}x${height}: rich domain-shift disclosure reachable`,
      );
      check(
        (await page.locator("#policy").isVisible()) &&
          (await page.locator("#terrain").isVisible()),
        `${width}x${height}: preserved selectors reachable`,
      );
      if (width === 320) {
        await page
          .locator("#terrain")
          .evaluate((el) =>
            window.scrollTo(
              0,
              window.scrollY + el.getBoundingClientRect().top - 100,
            ),
          );
        const box = await page.locator("#terrain").boundingBox();
        check(
          box.y >= 40 && box.y + box.height < height - 110,
          "320px terrain selector reaches touchable viewport above playback",
        );
        await page.locator("#terrain").click();
        await page.keyboard.press("Escape");
        await page.locator("#b-play").click();
        await page.waitForTimeout(150);
        await page.locator("#b-play").click();
        check(
          (await state()).t > 20,
          "320px touch-sized playback controls operate",
        );
      }
      layouts.push({
        width,
        height,
        geometry,
        performance: (await info()).performance,
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(
      "?terrain=rich&guidance=ml&policy=active&paused=1&t=20&cam=ground&speed=0.5",
    );
    await page.locator("#inspector > summary").click();
    await page.locator("#policy").selectOption("baseline");
    await page.waitForFunction(
      () => window.__demo3d?.state().policy === "baseline",
    );
    check(
      (await state()).terrain === "rich" &&
        (await state()).camera === "ground" &&
        (await state()).speed === 0.5,
      "planner switch preserves terrain, camera and speed",
    );
    await page.locator("#inspector > summary").click();
    await page.locator("#terrain").selectOption("original");
    await page.waitForFunction(
      () => window.__demo3d?.state().terrain === "original",
    );
    check(
      (await state()).policy === "baseline",
      "terrain switch preserves planner",
    );
  }
  if (process.env.BV_SKIP_MOTION !== "1") {
    for (const cam of ["cinematic", "chase", "ground", "orbit"]) {
      await open(`?terrain=rich&guidance=ml&policy=active&paused=1&t=12&cam=${cam}`);
      await page.waitForTimeout(1200);
      examples.push({purpose:"cold t12 camera startup",cam,...await info()});
    }
  }
  if (process.env.BV_SKIP_MOTION !== "1")
    for (const cam of ["cinematic", "chase", "ground", "orbit"]) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(`?terrain=rich&guidance=ml&policy=active&cam=${cam}&speed=2`);
      for (const target of [15, 35, 55, 75]) {
        await page.waitForFunction(
          (t) => window.__demo3d.state().t >= t,
          target,
          { timeout: 180000 },
        );
        await page.screenshot({
          path: `${outDir}/motion-${cam}-${target}.png`,
        });
      }
      const result = await info();
      motions.push({ cam, ...result });
      check(
        result.state.t === 75 && !result.state.playing,
        `${cam}: full75s motion completes`,
      );
      check(
        result.performance.frameTimes.every(Number.isFinite),
        `${cam}: finite rendering intervals`,
      );
    }
  check(errors.length === 0, "no runtime errors", errors);
  const unexpected = consoleErrors.filter((s) => !s.includes("404"));
  check(unexpected.length === 0, "no unexpected console errors", unexpected);
  const external = requests.filter(
    (u) => !u.startsWith(base) && !u.startsWith("blob:"),
  );
  check(external.length === 0, "no external app requests", external);
} finally {
  writeFileSync(
    `${root}ml/results/${process.env.BV_REPORT_NAME ?? "intelligence_browser"}.json`,
    JSON.stringify(
      {
        checks,
        errors,
        consoleErrors,
        requests: [...new Set(requests)],
        examples,
        layouts,
        motions,
        pixels,
      },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
  await server.httpServer.close();
}
if (checks.some((c) => !c.ok)) process.exitCode = 1;
