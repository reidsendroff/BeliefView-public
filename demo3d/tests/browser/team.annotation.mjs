/** Focused regression for stable three-drone camera annotation labels. */
import { chromium } from "playwright-core";
import { preview } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const port = Number(process.env.BV_ANNOTATION_PORT ?? 4186);
const server = await preview({
  root,
  preview: { port, strictPort: true, host: "127.0.0.1" },
});
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail)}`);
};
const measure = () =>
  page.evaluate(() => {
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const panes = Object.fromEntries(["A", "B", "C"].map((id) => {
      const sensor = document.getElementById(`sensor-${id}`);
      const key = document.getElementById(`annotation-key-${id}`);
      const marker = document.getElementById(`annotation-${id}`);
      const markerStyle = getComputedStyle(marker);
      const swatches = Object.fromEntries(["own", "prediction"].map((state) => {
        const style = getComputedStyle(key.querySelector(`.team-annotation-key-swatch.${state}`));
        return [state, { borderStyle: style.borderTopStyle, borderRadius: style.borderTopLeftRadius, borderColor: style.borderTopColor }];
      }));
      return [id, { sensor: rect(sensor), key: rect(key), text: key.textContent.trim(), keyVisible: getComputedStyle(key).visibility !== "hidden", keyLabel: key.getAttribute("aria-label"), keyRole: key.getAttribute("role"), keyFontSize: getComputedStyle(key).fontSize, markerText: marker.textContent.trim(), markerChildren: marker.children.length, markerHidden: marker.hidden, markerPrediction: marker.classList.contains("is-prediction"), markerAriaHidden: marker.getAttribute("aria-hidden"), markerStyle: { borderStyle: markerStyle.borderTopStyle, borderRadius: markerStyle.borderTopLeftRadius, borderColor: markerStyle.borderTopColor }, swatches, markerX: marker.style.left, markerY: marker.style.top }];
    }));
    return { ...panes, annotationsEnabled: window.__team.analysisFlags.annotations, playing: window.__team.playing, time: window.__team.time };
  });

try {
  await page.goto(`http://127.0.0.1:${port}/?mission=team&fleet=3&teamarm=coordinated&missionIndex=16&terrain=rich&duration=75&paused=1&t=24.5&annotations=1`);
  await page.waitForFunction(() => window.__team?.firstFrameMs > 0, null, { timeout: 120000 });
  await page.setViewportSize({ width: 1280, height: 720 });
  const snapshots = [];
  for (const time of [24.5, 45, 70, 24.5]) {
    await page.locator("#team-scrub").fill(String(time));
    await page.locator("#team-scrub").dispatchEvent("input");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    snapshots.push(await measure());
  }
  const first = snapshots[0], stable = snapshots.every((sample) => ["A", "B", "C"].every((id) => {
    const a = first[id].key, b = sample[id].key;
    return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5 && a.text === b.text;
  }));
  check(stable, "all three labels keep fixed pane positions and wording across forward/backward seeks", snapshots);
  check(["A", "B", "C"].every((id) => snapshots.every((s) => s[id].keyVisible && !s[id].markerText && s[id].markerChildren === 0 && s[id].key.y >= s[id].sensor.bottom - 0.5)), "three-drone labels sit outside raw camera images and are detached from moving markers", snapshots);
  check(snapshots[0].B.markerHidden === false && snapshots[1].B.markerHidden === false && (snapshots[0].B.markerX !== snapshots[1].B.markerX || snapshots[0].B.markerY !== snapshots[1].B.markerY), "projected marker can move while its camera label remains fixed", snapshots);
  check(snapshots[0].B.markerPrediction && !snapshots[1].B.markerPrediction, "dashed prediction and solid own-report marker states remain distinguishable", snapshots);
  check(snapshots[0].annotationsEnabled === true && snapshots.every((s) => !s.playing), "the seek and toggle checks run with playback paused", snapshots);
  check(["A", "B", "C"].every((id) => snapshots.every((s) => s[id].keyRole === "group" && s[id].keyLabel === `Drone ${id} camera marker key` && parseFloat(s[id].keyFontSize) >= 11 && s[id].markerAriaHidden === "true")), "each 11px marker key is accessible, tied to its camera, and the decorative marker is hidden from assistive technology", snapshots);
  const ownMarker = snapshots[1].B.markerStyle, ownSwatch = snapshots[1].B.swatches.own;
  const predictedMarker = snapshots[0].B.markerStyle, predictedSwatch = snapshots[0].B.swatches.prediction;
  check(ownMarker.borderStyle === ownSwatch.borderStyle && ownMarker.borderRadius === ownSwatch.borderRadius && ownMarker.borderColor === ownSwatch.borderColor && predictedMarker.borderStyle === predictedSwatch.borderStyle && predictedMarker.borderRadius === predictedSwatch.borderRadius && predictedMarker.borderColor === predictedSwatch.borderColor, "each key swatch matches its live marker style and color", { ownMarker, ownSwatch, predictedMarker, predictedSwatch });
  const desktop = await page.evaluate(() => {
    const rect = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { bottom: r.bottom, top: r.top }; };
    return { sensors: [...document.querySelectorAll(".team-sensor, .team-annotation-key")].map((e) => e.getBoundingClientRect().bottom), spectator: rect("#spectator-pane"), playback: rect(".team-playback"), viewportHeight: innerHeight, pageWidth: document.documentElement.scrollWidth };
  });
  check(desktop.sensors.every((bottom) => bottom <= desktop.playback.top + 1) && desktop.spectator.bottom <= desktop.playback.top + 1 && desktop.pageWidth <= 1280 && desktop.playback.bottom <= desktop.viewportHeight, "three feeds, spectator, and playback fit the 1280x720 viewport", desktop);

  await page.locator("#team-evidence-toggle").click();
  const canvasBefore = await page.evaluate(() => {
    const c = document.querySelector("#stage canvas"), r = c.getBoundingClientRect();
    return { width: c.width, height: c.height, x: r.x, y: r.y, cssWidth: r.width, cssHeight: r.height };
  });
  await page.locator("#team-overlay-annotations").click();
  await page.waitForFunction(() => window.__team.analysisFlags.annotations === false && ["A", "B", "C"].every((id) => document.getElementById(`annotation-${id}`).hidden), null, { timeout: 5000 });
  const off = await measure();
  const canvasOff = await page.evaluate(() => {
    const c = document.querySelector("#stage canvas"), r = c.getBoundingClientRect();
    return { width: c.width, height: c.height, x: r.x, y: r.y, cssWidth: r.width, cssHeight: r.height };
  });
  const reservedSlots = ["A", "B", "C"].every((id) => Math.abs(off[id].key.y - snapshots[0][id].key.y) < 0.5 && Math.abs(off[id].sensor.y - snapshots[0][id].sensor.y) < 0.5);
  check(off.annotationsEnabled === false && !off.playing && off.time === snapshots[0].time && ["A", "B", "C"].every((id) => !off[id].keyVisible && off[id].markerHidden) && reservedSlots && JSON.stringify(canvasBefore) === JSON.stringify(canvasOff), "paused annotation toggle hides every marker/key without advancing or changing layout", { off, canvasBefore, canvasOff });
  await page.locator("#team-overlay-annotations").click();
  await page.waitForFunction(() => window.__team.analysisFlags.annotations === true, null, { timeout: 5000 });
  const on = await measure();
  check(["A", "B", "C"].every((id) => on[id].keyVisible) && !on.B.markerHidden && on.B.markerPrediction && on.B.markerX === snapshots[0].B.markerX && on.B.markerY === snapshots[0].B.markerY, "paused annotation toggle restores the marker at its recorded projection and its fixed key", on);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => document.getElementById("team-content").scrollTo(0, 0));
    const mobile = await measure();
    const fitsMobile = ["A", "B", "C"].every((id) => mobile[id].key.x >= 0 && mobile[id].key.right <= width && mobile[id].key.y >= mobile[id].sensor.bottom - 0.5);
    check(fitsMobile && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `fixed labels fit the ${width}px camera layout without horizontal overflow`, mobile);
  }

  await page.goto(`http://127.0.0.1:${port}/?mission=team&fleet=2&teamarm=shared&missionIndex=16&terrain=rich&duration=75&paused=1&t=24.5&annotations=1`);
  await page.waitForFunction(() => window.__team?.firstFrameMs > 0, null, { timeout: 120000 });
  const reportTime = await page.evaluate(() => window.__team.timeline.frames.find((f) => f.aircraft.find((a) => a.id === "A")?.observation)?.t ?? null);
  if (reportTime === null) throw Error("No fleet-2 own-report frame was recorded");
  await page.locator("#team-scrub").fill(String(reportTime));
  await page.locator("#team-scrub").dispatchEvent("input");
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const legacyMarker = await page.evaluate(() => {
    const marker = document.getElementById("annotation-A");
    return { hidden: marker.hidden, children: marker.children.length, text: marker.textContent.trim(), state: marker.classList.contains("is-prediction") };
  });
  check(!legacyMarker.hidden && legacyMarker.children === 1 && legacyMarker.text === "Own noisy report" && !legacyMarker.state, "two-drone runtime retains its moving own-report callout", legacyMarker);
  check(errors.length === 0, "no browser runtime errors", errors);
} finally {
  await browser.close();
  await server.httpServer.close();
}
