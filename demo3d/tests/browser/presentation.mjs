/** Local production-build UI verification. Outputs separate evidence; never overwrites historical ML audit. */
import { chromium } from "playwright-core";
import { preview } from "vite";
import { existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const headed = process.env.BV_HEADED === "1";
const focused = process.env.BV_FOCUSED === "1";
const outDir = `${root}output/playwright/${headed ? "search-story-final" : "search-story"}`;
mkdirSync(outDir, { recursive: true });
const server = await preview({root, preview: {port: 4181, strictPort: true, host: "127.0.0.1"}});
const base = "http://127.0.0.1:4181/";
const cache = `${homedir()}/Library/Caches/ms-playwright`;
const found = readdirSync(cache).filter(d => d.startsWith("chromium_headless_shell-")).sort().reverse().flatMap(d => readdirSync(`${cache}/${d}`).map(a => `${cache}/${d}/${a}/chrome-headless-shell`)).filter(existsSync);
const browser = await chromium.launch({ executablePath: process.env.BV_CHROMIUM ?? (headed ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : found[0]), headless: !headed, args: headed ? [] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const checks = [], errors = [], consoleErrors = [], requests = [], examples = [], layouts = [], motions = [];
function check(ok, message) { checks.push({ok:!!ok,message}); console.log(`${ok ? "PASS" : "FAIL"} ${message}`); }
const ctx = await browser.newContext({viewport:{width:1440,height:900}});
const page = await ctx.newPage();
page.on("pageerror", e => errors.push(String(e)));
page.on("console", m => { if(m.type()==="error") consoleErrors.push(m.text()); });
page.on("request", r => { if (!r.url().startsWith("blob:")) requests.push(r.url()); });
async function open(query) {
  await page.goto(base+query);
  await page.waitForFunction(() => window.__demo3d?.performance().firstFrameMs > 0, null, {timeout:180000});
}
const state = () => page.evaluate(() => window.__demo3d.state());
const ml = () => page.evaluate(() => ({digest:window.__demo3d.ml.framesDigest(),active:window.__demo3d.ml.active,info:window.__demo3d.ml.info(),stats:window.__demo3d.ml.stats(),guidanceStats:window.__demo3d.ml.guidance(),start:window.__demo3d.ml.droneStart(),performance:window.__demo3d.performance()}));
try {
  if (!focused) {
  for (const scenario of ["original","forest","challenge"]) {
    for (const guidance of ["kalman","ml"]) {
      const query = `?scenario=${scenario}&guidance=${guidance}&paused=1&t=12&cam=chase&speed=0.5`;
      await open(query); const first = await ml();
      check(first.active === guidance, `${scenario}: ${guidance} active`);
      await page.waitForTimeout(1800);
      const measured = await ml();
      await page.screenshot({path:`${outDir}/${scenario}-${guidance}.png`});
      await open(query); const second = await ml();
      check(first.digest === second.digest, `${scenario}: deterministic ${guidance} digest ${first.digest}`);
      examples.push({scenario,guidance,...measured});
    }
  }
  const challengeKalman = examples.find(e=>e.scenario==="challenge"&&e.guidance==="kalman");
  await open("?scenario=challenge&guidance=ml&paused=1&mlManifest=/missing.json");
  check((await ml()).active==="kalman" && (await ml()).digest===challengeKalman.digest, "missing model falls back to selected challenge scenario");
  check((await page.locator("#ml-active").innerText()).includes("FALLBACK"), "fallback is explicit in persistent active line");
  await page.route("**/model.onnx", async route => { const r=await route.fetch();const b=Buffer.from(await r.body());b[b.length-1]^=1;await route.fulfill({response:r,body:b}); });
  await open("?scenario=challenge&guidance=ml&paused=1");
  check((await ml()).active==="kalman" && (await ml()).digest===challengeKalman.digest,"corrupted model falls back to selected challenge scenario");
  await page.unroute("**/model.onnx");
  await open("?scenario=original&guidance=ml&paused=1&t=12&cam=ground&speed=0.5");
  await page.locator("#inspector > summary").click();
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, "writeText", { configurable:true, value:async text => { window.__copiedReplay = text; } }));
  await page.locator("#b-link").click();
  const copied = new URL(await page.evaluate(() => window.__copiedReplay));
  check(copied.searchParams.get("cam")==="ground" && copied.searchParams.get("speed")==="0.5" && copied.searchParams.get("paused")==="1" && copied.searchParams.get("scenario")==="original", "copy replay serializes scenario, camera, speed and paused state without touching OS clipboard");
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, "writeText", { configurable:true, value:async () => { throw new Error("clipboard denied"); } }));
  await page.locator("#b-link").click();
  check((await page.locator("#link-status").innerText()).includes("address bar") && new URL(page.url()).searchParams.get("paused")==="1", "clipboard denial supplies replay in address bar");
  await page.locator('#guidance button[data-g="kalman"]').click();
  await page.waitForFunction(()=>window.__demo3d?.ml.active==="kalman");
  check((await state()).camera==="ground" && (await state()).speed===.5 && !(await state()).playing,"policy switch preserves camera, speed and pause");
  await page.locator("#inspector > summary").click();
  await page.locator("#scenario").selectOption("challenge");
  await page.waitForFunction(()=>window.__demo3d?.state().scenario==="challenge");
  check((await state()).t===0 && (await state()).camera==="ground" && (await state()).speed===.5,"scenario switch restarts while preserving camera and speed");
  await page.locator('#cams button[data-cam="chase"]').click();
  await page.keyboard.press("1");
  check((await state()).camera==="cinematic", "camera keyboard shortcut works after button focus");
  await page.locator("#b-play").click(); await page.waitForTimeout(300); await page.locator("#b-play").click();
  const pausedAt = (await state()).t; await page.waitForTimeout(150);
  check((await state()).t===pausedAt && pausedAt>0,"play advances and pause freezes time");
  await page.locator("#scrub").fill("5000");
  check(Math.abs((await state()).t-37.5)<.01,"scrub seeks to requested time");
  await page.locator("#b-restart").click(); await page.evaluate(()=>window.__demo3d.pause());
  check((await state()).t<.2,"restart returns to start");
  await page.locator("#inspector > summary").click();
  await page.locator("#controls > summary").click();
  await page.locator("#t-truth").check(); await page.locator("#t-trail").check(); await page.locator("#t-truth").uncheck();
  check(!(await page.locator("#t-trail").isChecked()) && await page.locator("#t-trail").isDisabled(),"truth off disables and clears true-path trail");
  await page.locator("#scenario").focus(); await page.keyboard.press("ArrowDown");
  check(!(await state()).playing,"native selection keyboard does not start playback");
  await open("?paused=1&cam=invalid"); check((await state()).camera==="cinematic","invalid camera safely defaults");
  }
  // Geometry at closed and fully opened inspector. Essential controls never overlap the sensor inset.
  for (const [width,height] of [[1440,900],[390,844],[390,667],[320,568],[844,390]]) {
    await page.setViewportSize({width,height});
    await open("?guidance=ml&paused=1&t=12");
    if (focused) { await page.waitForTimeout(2000); examples.push({width,height,...await ml()}); }
    for (const expanded of [false,true]) {
      if (expanded) { await page.locator("#inspector > summary").click(); await page.locator("#controls > summary").click(); await page.locator("#model-details > summary").click(); }
      const geometry = await page.evaluate(() => {
        const ids=["inset","status","inspector","camera-toolbar","timeline","disclosure","cam-label","ml-active"];
        return Object.fromEntries(ids.map(id=>{const r=document.getElementById(id).getBoundingClientRect();return [id,{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}];}));
      });
      const overlap=(a,b)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y));
      check(["status","inspector","camera-toolbar","timeline"].every(id=>overlap(geometry[id],geometry.inset)<1),`${width}x${height} ${expanded?"open":"closed"}: inset unobstructed`);
      check(["camera-toolbar","timeline","ml-active"].every(id=>geometry[id].x>=0&&geometry[id].right<=width+.5&&geometry[id].y>=0&&geometry[id].bottom<=height),`${width}x${height}: essential controls within viewport`);
      check(overlap(geometry.inspector,geometry["ml-active"])<1,`${width}x${height}: inspector does not cover active/fallback line`);
      layouts.push({width,height,expanded,geometry});
      await page.screenshot({path:`${outDir}/layout-${width}x${height}-${expanded?"open":"closed"}.png`});
    }
  }
  await page.setViewportSize({width:1440,height:900});
  // Full 75 s episodes at supported 2x speed, one per camera. Sequential rendering, not seek-only DOM checks.
  if (process.env.BV_SKIP_MOTION !== "1") for (const camera of ["cinematic","chase","ground","orbit"]) {
    await open(`?guidance=ml&speed=2&cam=${camera}&paused=1`);
    await page.locator("#b-play").click();
    const samples=[];
    const deadline = Date.now() + 180000;
    for(let j=0;(await state()).t<75 && Date.now()<deadline;j++) { await page.waitForTimeout(5000); samples.push(await state()); await page.screenshot({path:`${outDir}/motion-${camera}-${j}.png`}); }
    check((await state()).t===75 && !(await state()).playing,`${camera}: complete episode reaches end and stops`);
    motions.push({camera,samples,performance:(await ml()).performance});
  }
  check(errors.length===0,`no runtime page errors (${errors.length})`);
  const unexpectedConsoleErrors = consoleErrors.filter(s => !/Failed to load resource.*404/.test(s));
  check(unexpectedConsoleErrors.length===0, `no unexpected console errors (${unexpectedConsoleErrors.length})`);
  const external=[...new Set(requests.filter(u=>new URL(u).origin!==new URL(base).origin))];
  check(external.length===0,"all asset requests remain on local origin; no external transmission");
  writeFileSync(`${root}ml/results/${process.env.BV_REPORT_NAME ?? "search_story_browser.json"}`, JSON.stringify({browser:browser.version(), headed, focused, note:"Browser mode is recorded by headed flag; headed Chrome uses the normal GPU path, headless uses software WebGL. Sequential production-build checks; timings include scheduling and are not real-world validation. firstFrameMs is navigation-to-first rendered frame including only camera work required at the selected replay time (t12 layout loads exercise the lazy close-shot rig; t0 motion loads may defer it); bootMs includes model load and simulation; stageMs is scene/camera construction. Frame intervals from latest <=300 rendered frames.",checks,examples,layouts,motions,errors,consoleErrors,unexpectedConsoleErrors,externalRequests:external},null,2)+"\n");
} finally { await browser.close(); await server.close(); }
if(checks.some(c=>!c.ok)) process.exitCode=1;
