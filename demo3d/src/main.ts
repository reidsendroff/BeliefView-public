import { Hud } from "./render/hud";
import { Stage, type CameraMode } from "./render/stage";
import { sampleAt } from "./sim/playback";
import { bootGuidance, type BootStatus } from "./ml/boot";
import { MlOverlay } from "./render/mlOverlay";

import { SCENARIOS, scenarioFromQuery } from "./scenarioCatalog";
import type { PolicyTimeline } from "./sim/policyRuntime";
import { searchStory } from "./render/searchStory";

// Layout containers use real document flow; camera panes never overlap controls.
const workspace = document.createElement("main"); workspace.id = "workspace";
const views = document.createElement("div"); views.id = "views";
views.append(document.getElementById("inset")!, document.getElementById("spectator-pane")!);
const dashboard = document.createElement("div"); dashboard.id = "dashboard";
const mapPanel = document.createElement("section"); mapPanel.id = "map-panel"; mapPanel.setAttribute("aria-label", "Belief map and altitude");
mapPanel.append(document.getElementById("minimap")!, document.getElementById("minimap-cap")!, document.getElementById("altgauge")!);
dashboard.append(document.getElementById("status")!, document.getElementById("inspector")!, mapPanel);
workspace.append(dashboard.querySelector("#ml-active")!, views, document.getElementById("cam-label")!, dashboard);
document.body.append(workspace);

const startupStarted = performance.now();
const q = new URLSearchParams(location.search);
const $ = (id: string) => document.getElementById(id)!;

// Guidance: Kalman is the default. `?guidance=ml` computes the run with the learned ONNX model (async, fixed-step predictions).
function statusText(s: BootStatus): [string, string] {
  switch (s.state) {
    case "idle": return ["Model: not loaded (Kalman guidance selected)", ""];
    case "loading": return [`Model: loading… (${s.detail})`, ""];
    case "computing": return [`Model: ready · computing learned-guidance run ${Math.round(s.frac * 100)}%`, ""];
    case "ready": return [`Model: ready · ${s.modelId} v${s.version} · sha256 ${s.sha256.slice(0, 12)}… · ${(s.bytes / 1024).toFixed(0)} KB · loaded in ${s.loadMs.toFixed(0)} ms`, "ready"];
    case "error": return [`Model: unavailable (${s.message}). Using Kalman guidance.`, "error"];
  }
}
function showStatus(s: BootStatus): void {
  const [txt, cls] = statusText(s);
  $("ml-status").textContent = txt;
  $("ml-status").className = cls;
  $("ml-loading-msg").textContent = txt;
}
const scenario = scenarioFromQuery(q);
const scenarioSelect = $("scenario") as HTMLSelectElement;
for (const entry of SCENARIOS) { const opt = document.createElement("option"); opt.value = entry.id; opt.textContent = entry.title; scenarioSelect.appendChild(opt); }
scenarioSelect.value = scenario.id;
$("scenario-description").textContent = scenario.description;

const wantMl = q.get("guidance") === "ml";
if (wantMl) { $("ml-loading").hidden = false; showStatus({ state: "loading", detail: "starting" }); }
const boot = await bootGuidance(q, import.meta.env.BASE_URL, showStatus, scenario.config);
$("ml-loading").hidden = true;
if (wantMl) showStatus(boot.active === "ml" ? { state: "ready", modelId: boot.model!.manifest.modelId, version: boot.model!.manifest.modelVersion, sha256: boot.model!.info.sha256, bytes: boot.model!.info.bytes, loadMs: boot.model!.info.loadMs } : { state: "error", message: boot.error ?? "unknown" });
const bootMs = performance.now() - startupStarted;
const tl = boot.tl as PolicyTimeline;
const terrainChoice = q.get("terrain") === "rich" ? "rich" : "original";
const policyChoice = q.get("policy") === "active" ? "active" : "baseline";
($("terrain") as HTMLSelectElement).value = terrainChoice;
($("policy") as HTMLSelectElement).value = policyChoice;
$("domain-note").hidden = terrainChoice !== "rich";
$("active-scoring-note").hidden = policyChoice !== "active";
// The selector shows the ACTIVE policy (what is really driving the drone), not merely the requested one.
document.querySelectorAll<HTMLButtonElement>("#guidance button").forEach((b) => {
  b.classList.toggle("on", b.dataset.g === boot.active);
  b.classList.toggle("failed", wantMl && boot.active !== "ml" && b.dataset.g === "ml");
  b.setAttribute("aria-pressed", String(b.dataset.g === boot.active));
  b.addEventListener("click", () => {
    const u = new URL(location.href);
    u.searchParams.set("guidance", b.dataset.g!);
    writeReplayState(u);
    location.href = u.toString();
  });
});
{
  const act = $("ml-active");
  if (boot.active === "ml") act.textContent = `Active guidance: Learned (ONNX) · ${policyChoice === "active" ? "active search v2" : "frozen baseline"}`;
  else if (wantMl) { act.textContent = "Active guidance: Kalman - FALLBACK (learned model unavailable; Learned was requested)"; act.className = "fallback"; }
  else act.textContent = "Active guidance: Kalman";
}
const dur = tl.frames[tl.frames.length - 1].t;
const stageStarted = performance.now();
const stage = new Stage(document.getElementById("stage")!, tl);
const stageMs = performance.now() - stageStarted;
const hud = new Hud(tl, stage);
const overlay = boot.active === "ml" ? new MlOverlay(stage, tl, boot.regionLevel!) : null;
if (overlay) {
  const cb = $("t-ml") as HTMLInputElement;
  cb.disabled = false;
  cb.checked = true;
  $("t-pred-label").classList.add("kalman");
  $("t-pred-label").textContent = "Kalman prediction corridor & uncertainty (tracker, not the learned model)";
  $("minimap-cap").textContent = "Belief map · Kalman tracker + learned (violet)";
  $("ml-setup-note").hidden = false;
  const cov = boot.coverage;
  $("ml-coverage").textContent = cov ? `${(cov.value * 100).toFixed(1)}% (historical ${cov.label}, original policy/terrain) · not guaranteed${terrainChoice === "rich" || policyChoice === "active" ? "; current variant not calibrated" : ""}` : "not recorded in the manifest";
  if (cov) $("ml-coverage").title = `${cov.label}: ${cov.samples.toLocaleString("en-US")} prediction ticks over ${cov.episodes} held-out episodes; the region was calibrated on validation data to target 95%`;
  cb.addEventListener("change", () => { overlay.show = cb.checked; });
}

let t = Math.min(Math.max(Number(q.get("t") ?? 0) || 0, 0), dur);
let playing = q.get("paused") !== "1";
let speed = Number(q.get("speed") ?? 1) || 1;
if (![0.5, 1, 2].includes(speed)) speed = 1;

function writeReplayState(u: URL): void {
  u.searchParams.set("scenario", scenario.id);
  u.searchParams.set("t", t.toFixed(2));
  u.searchParams.set("speed", String(speed));
  u.searchParams.set("cam", stage.mode);
  u.searchParams.set("truth", stage.showTruth ? "1" : "0");
  if (!playing) u.searchParams.set("paused", "1"); else u.searchParams.delete("paused");
}
scenarioSelect.addEventListener("change", () => {
  const u = new URL(location.href); writeReplayState(u);
  u.searchParams.set("scenario", scenarioSelect.value); u.searchParams.set("t", "0");
  location.href = u.toString();
});
for (const id of ["terrain", "policy"]) $(id).addEventListener("change", () => { const u = new URL(location.href); writeReplayState(u); u.searchParams.set(id, ($(id) as HTMLSelectElement).value); u.searchParams.set("t", "0"); location.href = u.toString(); });
$("b-link").addEventListener("click", async () => {
  const u = new URL(location.href); writeReplayState(u); u.searchParams.set("paused", "1");
  try { await navigator.clipboard.writeText(u.toString()); $("link-status").textContent = "Link copied"; }
  catch { $("link-status").textContent = "Copy this page URL from the address bar"; history.replaceState(null, "", u); }
});

function setCam(m: CameraMode): void {
  if (!["cinematic", "chase", "ground", "orbit"].includes(m)) m = "cinematic";
  stage.setMode(m);
  document.querySelectorAll<HTMLButtonElement>("#cams button").forEach((b) => { b.classList.toggle("on", b.dataset.cam === m); b.setAttribute("aria-pressed", String(b.dataset.cam === m)); });
}
function setSpeed(s: number): void {
  speed = s;
  document.querySelectorAll<HTMLButtonElement>("#speeds button").forEach((b) => b.classList.toggle("on", Number(b.dataset.s) === s));
}
function bind(id: string, get: () => boolean, set: (v: boolean) => void): void {
  const el = $(id) as HTMLInputElement;
  el.checked = get();
  el.addEventListener("change", () => set(el.checked));
}
// The footprint trail reveals the subject's true path, so it is gated on the ground-truth toggle.
function setTrail(v: boolean): void {
  stage.showTrail = v && stage.showTruth;
  ($("t-trail") as HTMLInputElement).checked = stage.showTrail;
}
function setTruth(v: boolean): void {
  stage.showTruth = v;
  ($("t-truth") as HTMLInputElement).checked = v;
  ($("t-trail") as HTMLInputElement).disabled = !v;
  if (!v) setTrail(false);
}
const toggles = {
  pred: () => { stage.showPrediction = !stage.showPrediction; ($("t-pred") as HTMLInputElement).checked = stage.showPrediction; },
  frus: () => { stage.showFrustum = !stage.showFrustum; ($("t-frus") as HTMLInputElement).checked = stage.showFrustum; },
  truth: () => setTruth(!stage.showTruth),
  trail: () => setTrail(!stage.showTrail),
  map: () => { hud.showMap = !hud.showMap; ($("t-map") as HTMLInputElement).checked = hud.showMap; $("minimap").classList.toggle("off", !hud.showMap); $("minimap-cap").classList.toggle("off", !hud.showMap); },
};
stage.showTruth = q.get("truth") === "1";
bind("t-pred", () => stage.showPrediction, (v) => (stage.showPrediction = v));
bind("t-see", () => stage.seeThrough, (v) => (stage.seeThrough = v));
bind("t-frus", () => stage.showFrustum, (v) => (stage.showFrustum = v));
bind("t-truth", () => stage.showTruth, setTruth);
bind("t-trail", () => stage.showTrail, setTrail);
setTruth(stage.showTruth);
bind("t-map", () => hud.showMap, (v) => { hud.showMap = v; $("minimap").classList.toggle("off", !v); $("minimap-cap").classList.toggle("off", !v); });

document.querySelectorAll<HTMLButtonElement>("#cams button").forEach((b) => b.addEventListener("click", () => setCam(b.dataset.cam as CameraMode)));
document.querySelectorAll<HTMLButtonElement>("#speeds button").forEach((b) => b.addEventListener("click", () => setSpeed(Number(b.dataset.s))));
const restart = () => { t = 0; playing = true; };
$("b-play").addEventListener("click", () => { if (t >= dur) t = 0; playing = !playing; });
$("b-restart").addEventListener("click", restart);
const scrub = $("scrub") as HTMLInputElement;
scrub.addEventListener("input", () => { t = (Number(scrub.value) / 10000) * dur; });
$("chips").addEventListener("click", (e) => {
  const m = (e.target as HTMLElement).closest<HTMLElement>(".chip2");
  if (m) t = Number(m.dataset.t);
});
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLElement) {
    if (e.target.isContentEditable || e.target.closest("input, select, textarea")) return;
    if ((e.key === " " || e.key === "Enter") && e.target.closest("button, summary")) return;
  }
  switch (e.key) {
    case " ": e.preventDefault(); if (t >= dur) t = 0; playing = !playing; break;
    case "ArrowRight": t = Math.min(dur, t + 2); break;
    case "ArrowLeft": t = Math.max(0, t - 2); break;
    case "r": case "R": restart(); break;
    case "1": setCam("cinematic"); break;
    case "2": setCam("chase"); break;
    case "3": setCam("ground"); break;
    case "4": setCam("orbit"); break;
    case "p": case "P": toggles.pred(); break;
    case "f": case "F": toggles.frus(); break;
    case "t": case "T": toggles.truth(); break;
    case "m": case "M": toggles.map(); break;
    case "l": case "L": toggles.trail(); break;
    case "g": case "G": if (overlay) { overlay.show = !overlay.show; ($("t-ml") as HTMLInputElement).checked = overlay.show; } break;
    case "c": case "C": stage.seeThrough = !stage.seeThrough; ($("t-see") as HTMLInputElement).checked = stage.seeThrough; break;
  }
});

setCam((q.get("cam") as CameraMode) || "cinematic");
setSpeed(speed);

const initMs = performance.now() - startupStarted;
let firstFrameMs = 0;
const frameTimes: number[] = [];
let last = performance.now();
function frame(now: number): void {
  const gap = now - last;
  if (firstFrameMs && !document.hidden) { frameTimes.push(gap); if (frameTimes.length > 300) frameTimes.shift(); }
  const dt = Math.min(gap / 1000, 0.1);
  last = now;
  if (playing) {
    t += dt * speed;
    if (t >= dur) { t = dur; playing = false; }
  }
  const smp = stage.update(t, dt);
  hud.update(smp, playing);
  if (overlay) {
    overlay.update(smp);
    overlay.drawMinimap();
    const st = boot.model!.stats;
    $("ml-latency").textContent = st.calls ? `${(st.totalMs / st.calls).toFixed(1)} ms mean · ${st.calls} calls` : "—";
  }
  const story = searchStory(smp.a, overlay?.current ?? null, boot.regionLevel, boot.active === "ml");
  $("story-title").textContent = story.title; $("story-intent").textContent = story.intent; $("story-belief").textContent = story.belief;
  $("cutaway-label").textContent = `CUTAWAY: ${stage.seeThrough ? "ON (evaluation only)" : "OFF"}`;
  if (boot.active === "ml" && policyChoice === "active" && smp.a.mode === "SEARCH" && smp.a.track.status === "SEARCHING" && tl.policy) {
    const decision = tl.policy.decisions.filter(d => d.t <= t).at(-1);
    const fallback = tl.policy.fallbacks.filter(d => d.t <= t).at(-1);
    if (fallback && (!decision || fallback.t >= decision.t)) $("story-intent").textContent = "No usable active-search viewpoint at this replan. The existing Kalman viewpoint heuristic is driving the search.";
    else if (decision) $("story-intent").textContent = "Search reachable viewpoints using the raw learned grid, a bounded exploration prior and a discount for recently sensed empty views. These are planning heuristics, not recalibrated probabilities.";
  }
  stage.render($("inset").getBoundingClientRect());
  if (!firstFrameMs) firstFrameMs = performance.now();
  if (frameTimes.length) {
    const sorted = [...frameTimes].sort((a,b) => a-b);
    $("runtime-stats").textContent = `Startup to first rendered frame: ${(firstFrameMs / 1000).toFixed(2)} s from navigation (includes camera work needed at this replay time; later camera precompute may still occur). App initialization: ${(initMs / 1000).toFixed(2)} s. Recent frame interval p50 / p95: ${sorted[Math.floor(sorted.length * .5)].toFixed(1)} / ${sorted[Math.floor(sorted.length * .95)].toFixed(1)} ms (${sorted.length} frames). Machine-specific, includes scheduling.`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Read-only hooks for smoke tests / debugging.
(window as unknown as Record<string, unknown>).__demo3d = {
  seek: (s: number) => { t = Math.max(0, Math.min(dur, Number.isFinite(s) ? s : 0)); },
  performance: () => ({ firstFrameMs, initMs, bootMs, stageMs, frameTimes: [...frameTimes] }),
  pause: () => { playing = false; },
  play: () => { playing = true; },
  state: () => {
    const s = sampleAt(tl.frames, t);
    return { t, playing, camera: stage.mode, speed, terrain: terrainChoice, policy: policyChoice, cutaway: stage.seeThrough, cutawayCount: stage.cutawayCount, scenario: scenario.id, status: s.a.track.status, mode: s.a.mode, agl: s.a.drone.agl, visibility: s.a.visibility, events: tl.events, subjectEval: { action: s.a.subject.action, speed: s.a.subject.speed, crouch: s.a.subject.crouch } };
  },
};

// Learned-guidance diagnostics for the browser smoke test (read-only).
(window as unknown as { __demo3d: Record<string, unknown> }).__demo3d.ml = {
  requested: boot.requested,
  active: boot.active,
  error: boot.error,
  manifestUrl: boot.manifestUrl,
  stats: () => (boot.model ? { ...boot.model.stats, samplesMs: [...boot.model.stats.samplesMs] } : null),
  info: () => (boot.model ? { ...boot.model.info, modelId: boot.model.manifest.modelId, version: boot.model.manifest.modelVersion } : null),
  guidance: () => tl.ml?.guidance ?? null,
  beliefTicks: () => tl.ml?.beliefs.filter(Boolean).length ?? 0,
  overlayVisible: () => !!overlay && overlay.show && overlay.current !== null && stage.showPrediction,
  readout: () => overlay?.readout ?? null,
  /** t=0 drone position of the run actually shown (coarse set-up must place it from the designated area, never the exact start). */
  droneStart: () => ({ x: tl.frames[0].drone.x, z: tl.frames[0].drone.z }),
  framesDigest: () => { let h = 2166136261; for (const f of tl.frames) for (const v of [f.drone.x, f.drone.y, f.drone.z, f.cam.yaw, f.cam.pitch, f.subject.x, f.subject.z]) { h = Math.imul(h ^ Math.round(v * 1e4), 16777619) >>> 0; } return h.toString(16); },
};
