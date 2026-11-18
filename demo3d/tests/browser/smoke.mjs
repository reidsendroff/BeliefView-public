/**
 * Real-browser smoke test (Chromium via playwright-core) against the production build served by `vite preview`.
 * Proves: Kalman is the default and loads no model; the learned mode really fetches manifest + ONNX + wasm, validates the hash,
 * runs inference, uses it for search guidance, draws the probability overlay, plays back deterministically, and fails closed
 * (hash mismatch / missing manifest) to Kalman. Writes measured latency to ml/results/browser_smoke.json.
 *
 *   npm run build && npm run test:browser
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { preview } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));
const shots = process.env.BV_SHOT_DIR ?? "/tmp";
const server = await preview({ root, preview: { port: 4179, strictPort: true, host: "127.0.0.1" } });
const base = "http://127.0.0.1:4179/";
const launchArgs = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
/** playwright-core pins an exact Chromium build; if it is not installed, fall back to BV_CHROMIUM or any cached headless shell. */
async function launch() {
  if (process.env.BV_HEADED === "1") return chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: false });
  try {
    return await chromium.launch({ args: launchArgs });
  } catch (e) {
    const cache = `${homedir()}/Library/Caches/ms-playwright`;
    const found = existsSync(cache)
      ? readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()
          .flatMap((d) => readdirSync(`${cache}/${d}`).map((a) => `${cache}/${d}/${a}/chrome-headless-shell`)).filter(existsSync)
      : [];
    const exe = process.env.BV_CHROMIUM ?? found[0];
    if (!exe) throw e;
    console.log(`(pinned Chromium missing; using ${exe})`);
    return chromium.launch({ executablePath: exe, args: launchArgs });
  }
}
const browser = await launch();
const failures = [];
const allChecks = []; // every check (including failures) is retained in ml/results/browser_smoke.json
const check = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  allChecks.push({ ok: !!cond, msg });
  if (!cond) failures.push(msg);
};
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

async function open(query, { route } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const requests = [];
  const errors = [];
  page.on("request", (r) => requests.push(new URL(r.url()).pathname));
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  if (route) await route(page);
  const t0 = Date.now();
  await page.goto(base + query, { waitUntil: "load" });
  await page.waitForFunction(() => window.__demo3d?.ml, null, { timeout: 180000 });
  return { ctx, page, requests, errors, bootMs: Date.now() - t0 };
}
const btnOn = async (page, g) => ((await page.getAttribute(`#guidance button[data-g="${g}"]`, "class")) ?? "").split(" ").includes("on");
const ml = (page, expr) => page.evaluate(`window.__demo3d.ml.${expr}`);

// ---------------------------------------------------------------- A. Kalman default
const A = await open("?paused=1&t=10");
check((await ml(A.page, "requested")) === "kalman" && (await ml(A.page, "active")) === "kalman", "default load is Kalman guidance");
check(!A.requests.some((p) => /model\.onnx|manifest\.json|\.wasm/.test(p)), "default (Kalman) page fetches no model, manifest or wasm");
check((await A.page.textContent("#ml-status")).includes("not loaded"), "status says the model is not loaded in Kalman mode");
const kalDigest = await ml(A.page, "framesDigest()");
// Strict boundary: browser Kalman uses the coarse set-up (drone placed from the 16 m designated area), not the legacy exact start (-41.41, -31.02).
const COARSE_START = { x: -24, z: -38 };
const startOf = async (p) => await ml(p, "droneStart()");
check(JSON.stringify(await startOf(A.page)) === JSON.stringify(COARSE_START), "default Kalman run uses the coarse set-up (drone start from designated area, not the exact subject start)");
for (const id of ["chip", "caption", "minimap", "inset", "disclosure", "cam-label", "altgauge", "timeline", "t-pred", "t-see", "t-frus", "t-map", "t-trail", "t-truth", "b-play", "scrub", "ml-disclosure"]) {
  check((await A.page.$(`#${id}`)) !== null, `element #${id} present`);
}
check((await A.page.textContent("#disclosure")).includes("SYNTHETIC ILLUSTRATIVE SIMULATION"), "existing synthetic disclosure banner unchanged");
check((await A.page.$$("#cams button")).length === 4, "four camera buttons");
check(!(await A.page.isChecked("#t-ml")) && (await A.page.isDisabled("#t-ml")), "Kalman mode: the learned-overlay checkbox is unchecked and disabled");
check((await btnOn(A.page, "kalman")) && !(await btnOn(A.page, "ml")), "Kalman mode: selector shows Kalman active");
check((await A.page.textContent("#ml-active")) === "Active guidance: Kalman", "Kalman mode: active-guidance line says Kalman");
check((await A.page.textContent("#t-pred-label")) === "Prediction & uncertainty", "Kalman mode: original Prediction & uncertainty label unchanged");
check(A.errors.length === 0, `no console/page errors in Kalman mode ${A.errors.slice(0, 2)}`);
await A.page.screenshot({ path: `${shots}/bv_shot_kalman.png` });
await A.ctx.close();

// ---------------------------------------------------------------- B. Learned mode (twice, for determinism)
const B = await open("?guidance=ml&paused=1&t=10");
check((await ml(B.page, "active")) === "ml", "learned mode active (model loaded and used)");
check(B.requests.some((p) => /manifest\.json$/.test(p)) && B.requests.some((p) => /model\.onnx$/.test(p)), "browser fetched manifest.json and model.onnx");
check(B.requests.some((p) => /\.wasm$/.test(p)), "browser fetched the onnxruntime wasm from this origin (no CDN)");
const st = await ml(B.page, "stats()");
const info = await ml(B.page, "info()");
check(st.calls > 5, `ONNX inference ran ${st.calls} times at fixed simulation steps`);
const g = await ml(B.page, "guidance()");
check(g.learnedChoices > 0, `learned scorer chose ${g.learnedChoices} search viewpoints`);
check((await ml(B.page, "beliefTicks()")) > 5, "belief grids recorded in the timeline");
const status = await B.page.textContent("#ml-status");
check(/ready/.test(status) && status.includes(info.sha256.slice(0, 12)), `status shows model provenance: ${status}`);
check((await B.page.textContent("#ml-active")) === "Active guidance: Learned (ONNX) · frozen baseline", "learned mode: active-guidance line says Learned");
check((await B.page.textContent("#t-pred-label")).includes("Kalman prediction corridor"), "learned mode: the existing Kalman corridor toggle is labelled as the tracker's, not the learned model's");
check(await B.page.isChecked("#t-ml"), "learned mode: learned-overlay checkbox is checked and enabled");
check(!(await B.page.textContent("body")).includes("Calibrated 95% region") && (await B.page.textContent("#mlpanel")).includes("Validation-calibrated region (target 95%)"), "UI says validation-calibrated region, not 'Calibrated 95% region'");
const covTxt = await B.page.textContent("#ml-coverage");
check(/\d+\.\d% \(historical final audit, original policy\/terrain\)/.test(covTxt) && /not guaranteed/.test(covTxt), `UI shows measured held-out coverage: ${covTxt}`);
check((await B.page.textContent("#ml-disclosure")).includes("Synthetic"), "synthetic disclosure for the learned model is visible");
await B.page.evaluate("window.__demo3d.seek(10)");
await B.page.waitForTimeout(600);
check(await ml(B.page, "overlayVisible()"), "learned probability overlay visible while the fix is missing");
const ro = await ml(B.page, "readout()");
check(ro && ro.peaks.length >= 1 && ro.region95M2 > 0, `uncertainty readout: ${ro?.peaks.length} peak(s), 95% region ${Math.round(ro?.region95M2)} m2`);
const heatPx = await B.page.evaluate(() => {
  const c = document.getElementById("minimap");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 150 && d[i] > 90 && d[i + 2] - d[i + 1] > 25) n++;
  return n;
});
check(heatPx > 200, `probability heat is drawn on the minimap (${heatPx} px)`);
await B.page.screenshot({ path: `${shots}/bv_shot_ml.png` });
await B.page.keyboard.press("4");
await B.page.waitForTimeout(1500);
await B.page.screenshot({ path: `${shots}/bv_shot_ml_orbit.png` });
await B.page.keyboard.press("g");
await B.page.waitForTimeout(300);
check(!(await ml(B.page, "overlayVisible()")), "G toggles the learned overlay off");
const digestB = await ml(B.page, "framesDigest()");
const stFinal = await ml(B.page, "stats()");
check(digestB !== kalDigest, "learned-guidance playback differs from Kalman (guidance is active)");
check(B.errors.length === 0, `no console/page errors in learned mode ${B.errors.slice(0, 2)}`);
await B.page.locator("#inspector > summary").click();
await B.page.click('#guidance button[data-g="kalman"]');
await B.page.waitForFunction(() => window.__demo3d?.ml?.requested === "kalman", null, { timeout: 30000 });
check(new URL(B.page.url()).searchParams.get("guidance") === "kalman", "selector switches back to Kalman");
await B.ctx.close();

const B2 = await open("?guidance=ml&paused=1&t=10");
check((await ml(B2.page, "framesDigest()")) === digestB, "deterministic playback: second load reproduces identical learned-guidance frames");
await B2.ctx.close();

// ---------------------------------------------------------------- C. Fail-closed fallbacks
const C = await open("?guidance=ml&paused=1&mlManifest=/models/does-not-exist/manifest.json");
check((await ml(C.page, "active")) === "kalman" && (await ml(C.page, "error")) !== null, "missing manifest -> Kalman fallback with an error");
check((await C.page.textContent("#ml-status")).includes("unavailable"), "status reports model unavailable");
check((await btnOn(C.page, "kalman")) && !(await btnOn(C.page, "ml")), "fallback: selector shows Kalman as the ACTIVE policy (not the requested learned one)");
check((await C.page.textContent("#ml-active")).includes("FALLBACK"), "fallback: active-guidance line says Kalman FALLBACK");
check(!(await C.page.isChecked("#t-ml")), "fallback: learned-overlay checkbox is unchecked");
const K = await open("?paused=1");
check((await ml(C.page, "framesDigest()")) === (await ml(K.page, "framesDigest()")), "fallback frames are identical to the default Kalman run");
check(JSON.stringify(await startOf(C.page)) === JSON.stringify(COARSE_START), "error fallback Kalman run also uses the coarse set-up");
await K.ctx.close();
await C.ctx.close();

const D = await open("?guidance=ml&paused=1", {
  route: async (page) => {
    await page.route("**/model.onnx", async (route) => {
      const r = await route.fetch();
      const b = Buffer.from(await r.body());
      b[b.length - 1] ^= 1;
      await route.fulfill({ response: r, body: b });
    });
  },
});
check((await ml(D.page, "active")) === "kalman" && /sha256 mismatch/.test((await ml(D.page, "error")) ?? ""), "tampered model bytes are rejected by the hash check (Kalman fallback)");
await D.ctx.close();

// ---------------------------------------------------------------- latency record (browser, wasm, 1 thread)
const samples = st.samplesMs;
const out = {
  schema: 1, browser: browser.version(), calls: stFinal.calls, loadMs: info.loadMs,
  p50Ms: pct(samples, 0.5), p95Ms: pct(samples, 0.95), maxMs: Math.max(...samples),
  precomputeWallMs: B.bootMs, modelSha256: info.sha256,
  checksPassed: allChecks.filter((c) => c.ok).length, checksFailed: allChecks.filter((c) => !c.ok).length, checks: allChecks,
  note: `${process.env.BV_HEADED === "1" ? "headed Chrome + GPU" : "headless Chromium + swiftshader"} on the development machine, onnxruntime-web wasm EP, 1 thread; indicative only`,
};
const reportPath = process.env.BV_REPORT_PATH ?? `${root}ml/results/browser_smoke.json`;
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(out));
await browser.close();
await server.close();
if (failures.length) {
  console.error(`\n${failures.length} FAILED:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nbrowser smoke: all checks passed");
