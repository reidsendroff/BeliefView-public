/** Local team replay. Rendering controls cannot change the already computed sensor transcript. */
import "./app.css";
import { teamMarkup } from "./template";
import { overlayFlags, OVERLAY_KEYS, displayFrameIndex } from "./presentation";
import { TeamOverlays, annotationPoint, projectAnnotation } from "./overlays";
import { buildThreePublicScenario } from "./threeScenario";
import { simulatedGpsText } from "./simulatedGps";
import * as THREE from "three";
import { Stage, type CameraMode } from "../render/stage";
import { CAMERA, forward } from "../sim/sensor";
import { lerp, lerpAngle } from "../sim/playback";
import { buildPublicScenario } from "./scenario";
import { TeamMap } from "./map";
import { ThreeGeometry } from "./threeGeometry";
import { GRID } from "./types";
import type { ReplayTimeline, ReplayFrame } from "./replay";
import type { SensorId } from "./types";
import {
  ARM_LABELS,
  fleetIds,
  replayFocus,
  validateReplayFleet,
  replayQuery,
  mapFingerprint,
  digest,
  deterministicReplay,
  spectatorTimeline,
  validateReplayHorizon,
} from "./replay";

const startup = performance.now(),
  query = new URLSearchParams(location.search),
  choice = replayQuery(query);
const disclosure = document.getElementById("disclosure")!.cloneNode(true);
document.body.classList.add("team-app");
document.body.replaceChildren(disclosure);
const root = document.createElement("main");
root.className = "team-shell";
root.id = "team-content";
root.innerHTML = teamMarkup(choice);
document.body.append(root);
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const ids = fleetIds(choice.fleet);
function fitViews() {
  const ready = $("team-ready");
  if (ready.hidden) return;
  const width = ready.clientWidth,
    height = ready.clientHeight;
  const sidebar =
    innerWidth < 1600 ? 0 : Math.min(330, Math.max(250, innerWidth * 0.19));
  const gridWidth = Math.max(
    0,
    Math.min(
      (width - sidebar - (sidebar ? 24 : 12)) / 2,
      (((height - 120) / 2) * 16) / 9,
    ),
  );
  const rowWidth = Math.max(
    0,
    Math.min(
      (width - sidebar - 12 * (choice.fleet - 1 + (sidebar ? 1 : 0))) /
        choice.fleet,
      ((height - 170) * 16) / 9,
    ),
  );
  const mobile =
    innerWidth <= 700 || (innerWidth <= 1000 && innerHeight <= 600);
  ready.dataset.arrangement = mobile
    ? "mobile"
    : rowWidth > gridWidth
      ? "row"
      : "grid";
  ready.style.setProperty("--feed-width", `${gridWidth}px`);
  ready.style.setProperty("--row-feed-width", `${rowWidth}px`);
  ready.style.setProperty(
    "--active-feed-width",
    `${rowWidth > gridWidth ? rowWidth : gridWidth}px`,
  );
  ready.style.setProperty("--sensor-count", String(choice.fleet));
  ready.style.setProperty("--evidence-column", String(choice.fleet + 1));
}
new ResizeObserver(fitViews).observe($("team-ready"));
window.addEventListener("resize", fitViews);

const analysisFlags = overlayFlags(query);
if (choice.fleet === 3)
  for (const id of ids)
    $<HTMLElement>(`annotation-key-${id}`).style.visibility =
      analysisFlags.annotations ? "visible" : "hidden";
for (const key of OVERLAY_KEYS) {
  const input = $<HTMLInputElement>(`team-overlay-${key}`);
  input.checked = analysisFlags[key];
  input.onchange = () => {
    analysisFlags[key] = input.checked;
    if (key === "annotations" && choice.fleet === 3)
      for (const id of ids)
        $<HTMLElement>(`annotation-key-${id}`).style.visibility =
          analysisFlags.annotations ? "visible" : "hidden";
    storeUrl();
  };
}
const fleetSelect = $<HTMLSelectElement>("team-fleet");
fleetSelect.value = String(choice.fleet);
const armSelect = $<HTMLSelectElement>("team-arm"),
  terrainSelect = $<HTMLSelectElement>("team-terrain"),
  missionSelect = $<HTMLSelectElement>("team-mission"),
  durationSelect = $<HTMLSelectElement>("team-duration");
durationSelect.value = String(choice.duration);
armSelect.value = choice.arm;
terrainSelect.value = choice.family;
$<HTMLDetailsElement>("team-config").open = false;
for (let i = 0; i < 32; i++) {
  const o = document.createElement("option");
  o.value = String(i);
  o.textContent = `Mission ${String(i + 1).padStart(2, "0")}`;
  missionSelect.append(o);
}
missionSelect.value = String(choice.index);
$("team-active").append(
  document.createTextNode(
    `Active team policy: ${ARM_LABELS[choice.arm]} / Development mission ${String(choice.index + 1).padStart(2, "0")} / ${choice.duration} s / ${choice.fleet} drones${choice.fleet === 2 && (choice.arm === "shared" || choice.arm === "coordinated") ? " / teammate assistance enabled" : ""}`,
  ),
);
const fact = document.createElement("small");
fact.textContent =
  "Analytic belief / exact known static map / no ONNX in team mode / illustrative development replay";
$("team-active").append(fact);
const shared = choice.arm === "shared" || choice.arm === "coordinated";
$("belief-title").textContent = shared
  ? "Analytic shared belief"
  : "Separate analytic beliefs";
$("belief-maps").innerHTML = (shared ? ["shared"] : ids)
  .map(
    (id) =>
      `<div class="team-belief"><figure><canvas id="map-${id}" width="256" height="256" aria-label="${id === "shared" ? "Shared" : `Drone ${id}`} model mass map"></canvas><figcaption>${id === "shared" ? "One shared posterior, not separate per-drone estimates" : `Drone ${id}: its own evidence only`}</figcaption></figure></div>`,
  )
  .join("");
let time = Math.max(0, Math.min(choice.duration, Number(query.get("t")) || 0)),
  playing = query.get("paused") !== "1",
  speed = [0.5, 1, 2, 4].includes(Number(query.get("speed")))
    ? Number(query.get("speed"))
    : 1;
let mode: CameraMode = ["cinematic", "chase", "ground", "orbit"].includes(
  query.get("cam") ?? "",
)
  ? (query.get("cam") as CameraMode)
  : "cinematic";
let focus: SensorId = replayFocus(query.get("focus"), choice.fleet);
$<HTMLSelectElement>("team-focus").value = focus;
let focusTimelines: ReturnType<typeof spectatorTimeline>[] = [];
let stage: Stage | null = null,
  worker: Worker | null = null,
  timeline: ReplayTimeline | null = null;
let maximumFrameIntervalMs = 0;
let firstFrameMs = 0,
  computeMs = 0,
  timelineDigest = "",
  verifiedMap = "",
  last = performance.now(),
  lastUrl = 0,
  frameIntervals: number[] = [];
function writeState(url = new URL(location.href)) {
  url.searchParams.set("mission", "team");
  url.searchParams.set("fleet", String(choice.fleet));
  url.searchParams.set("teamarm", choice.arm);
  url.searchParams.set("missionIndex", String(choice.index));
  url.searchParams.set("terrain", choice.family);
  url.searchParams.set("duration", String(choice.duration));
  url.searchParams.set("focus", focus);
  url.searchParams.set("t", time.toFixed(2));
  url.searchParams.set("speed", String(speed));
  url.searchParams.set("paused", playing ? "0" : "1");
  url.searchParams.set("cam", mode);
  url.searchParams.set(
    "cutaway",
    $<HTMLInputElement>("team-cutaway").checked ? "1" : "0",
  );
  url.searchParams.set(
    "truth",
    $<HTMLInputElement>("team-truth").checked ? "1" : "0",
  );
  url.searchParams.set(
    "frustum",
    $<HTMLInputElement>("team-frustum").checked ? "1" : "0",
  );
  for (const key of OVERLAY_KEYS)
    url.searchParams.set(key, analysisFlags[key] ? "1" : "0");
  return url;
}
function storeUrl() {
  history.replaceState(null, "", writeState());
  const u = writeState();
  u.searchParams.delete("mission");
  u.searchParams.delete("fleet");
  u.searchParams.delete("teamarm");
  u.searchParams.delete("missionIndex");
  u.searchParams.delete("duration");
  $("single-return").setAttribute("href", u.toString());
}
for (const [select, key] of [
  [fleetSelect, "fleet"],
  [armSelect, "teamarm"],
  [terrainSelect, "terrain"],
  [missionSelect, "missionIndex"],
  [durationSelect, "duration"],
] as const)
  select.addEventListener("change", () => {
    worker?.terminate();
    const u = writeState();
    u.searchParams.set(key, select.value);
    if (key === "fleet" && select.value === "2" && focus === "C")
      u.searchParams.set("focus", "A");
    if (key !== "teamarm") {
      u.searchParams.set("t", "0");
      u.searchParams.set("paused", "1");
    }
    location.href = u.toString();
  });
const playback = document.createElement("nav");
playback.className = "team-playback";
playback.setAttribute("aria-label", "Mission playback");
playback.innerHTML = `<button id="team-play" disabled>Pause</button><button id="team-restart" disabled aria-label="Restart mission">Restart</button><input id="team-scrub" aria-label="Mission time" type="range" min="0" max="${choice.duration}" step="0.05" value="0" disabled><output id="team-time">0.0 / ${choice.duration.toFixed(1)} s</output><select id="team-speed" aria-label="Playback speed"><option value="0.5">0.5x</option><option value="1">1x</option><option value="2">2x</option><option value="4">4x</option></select><button id="team-copy">Copy replay link</button>`;
document.body.append(playback);
$<HTMLSelectElement>("team-speed").value = String(speed);
function syncPlayback() {
  $("team-play").textContent = playing ? "Pause" : "Play";
  $<HTMLInputElement>("team-scrub").value = String(time);
  $("team-time").textContent =
    `${time.toFixed(1)} / ${choice.duration.toFixed(1)} s`;
}
$("team-play").onclick = () => {
  if (time >= choice.duration) time = 0;
  playing = !playing;
  syncPlayback();
  storeUrl();
};
$("team-restart").onclick = () => {
  time = 0;
  playing = true;
  syncPlayback();
  storeUrl();
};
$<HTMLInputElement>("team-scrub").oninput = () => {
  time = Number($<HTMLInputElement>("team-scrub").value);
  playing = false;
  syncPlayback();
  storeUrl();
};
$<HTMLSelectElement>("team-speed").onchange = () => {
  speed = Number($<HTMLSelectElement>("team-speed").value);
  storeUrl();
};
$("team-copy").onclick = async () => {
  const text = writeState().toString();
  try {
    await navigator.clipboard.writeText(text);
    $("team-toast").textContent = "Replay link copied.";
  } catch {
    const input = $<HTMLInputElement>("team-link-fallback");
    input.hidden = false;
    input.value = text;
    input.focus();
    input.select();
    $("team-toast").textContent = "Copy the selected replay link.";
  }
};
function updateFocusCaption() {
  $("spectator-focus-label").textContent =
    mode === "ground"
      ? "Evaluation only / Ground frames the subject"
      : mode === "orbit"
        ? "Evaluation only / manual Orbit"
        : `Evaluation only / follows Drone ${focus}`;
}
function setFocus() {
  focus = replayFocus($<HTMLSelectElement>("team-focus").value, choice.fleet);
  if (stage) stage.setSpectatorTimeline(focusTimelines[ids.indexOf(focus)]);
  updateFocusCaption();
  storeUrl();
}
$<HTMLSelectElement>("team-focus").onchange = setFocus;
function setCamera(value: CameraMode) {
  mode = value;
  stage?.setMode(mode);
  updateFocusCaption();
  document
    .querySelectorAll<HTMLButtonElement>("[data-camera]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.camera === mode)),
    );
  storeUrl();
}
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-camera]"))
  b.onclick = () => setCamera(b.dataset.camera as CameraMode);
for (const [id, key, initial] of [
  ["team-cutaway", "cutaway", true],
  ["team-truth", "truth", false],
  ["team-frustum", "frustum", true],
] as const) {
  const c = $<HTMLInputElement>(id);
  c.checked = query.has(key) ? query.get(key) === "1" : initial;
  c.onchange = () => {
    if (stage) {
      stage.seeThrough = $<HTMLInputElement>("team-cutaway").checked;
      stage.showTruth = $<HTMLInputElement>("team-truth").checked;
      stage.showFrustum = $<HTMLInputElement>("team-frustum").checked;
    }
    $("cutaway-label").textContent =
      `CUTAWAY: ${$<HTMLInputElement>("team-cutaway").checked ? "ON" : "OFF"}`;
    storeUrl();
  };
}
document.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest("input,select,textarea,[contenteditable=true]")) return;
  if (
    (e.code === "Space" || e.key === "Enter") &&
    target.closest("button,summary,a")
  )
    return;
  if (e.code === "Space") {
    e.preventDefault();
    $("team-play").click();
  }
  if (e.key.toLowerCase() === "r") $("team-restart").click();
  if ("1234".includes(e.key) && e.key.length === 1)
    setCamera(
      (["cinematic", "chase", "ground", "orbit"] as const)[Number(e.key) - 1],
    );
  if (e.key.toLowerCase() === "c") $<HTMLInputElement>("team-cutaway").click();
  if (e.key.toLowerCase() === "t") $<HTMLInputElement>("team-truth").click();
});
let evidenceOpener: HTMLElement | null = null;
function openEvidence(method = false) {
  evidenceOpener = document.activeElement as HTMLElement;
  if ($("team-ready").hidden) {
    const dialog = document.createElement("dialog");
    dialog.className = "team-method-dialog";
    dialog.setAttribute("aria-label", "Method and limits");
    const title = document.createElement("h2");
    title.textContent = "Method and limits";
    const close = document.createElement("button");
    close.textContent = "Close";
    close.onclick = () => dialog.close();
    dialog.append(title, close);
    for (const section of [
      $("team-method"),
      document.querySelector(".team-view-meaning")!,
    ]) {
      for (const paragraph of section.querySelectorAll("p")) {
        const copy = paragraph.cloneNode(true) as HTMLElement;
        copy.removeAttribute("id");
        dialog.append(copy);
      }
    }
    dialog.onclose = () => {
      dialog.remove();
      evidenceOpener?.focus();
    };
    document.body.append(dialog);
    dialog.showModal();
    return;
  }
  $("team-evidence-panel").classList.add("is-open");
  $("team-evidence-toggle").setAttribute("aria-expanded", "true");
  if (method) $<HTMLDetailsElement>("team-method").open = true;
  const target = method ? $("team-method") : $("team-evidence-panel");
  target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: method ? "end" : "nearest" });
}
function closeEvidence() {
  $("team-evidence-panel").classList.remove("is-open");
  $("team-evidence-toggle").setAttribute("aria-expanded", "false");
  evidenceOpener?.focus({ preventScroll: true });
}
$("team-method-open").onclick = () => openEvidence(true);
$("team-evidence-toggle").onclick = () =>
  $("team-evidence-panel").classList.contains("is-open")
    ? closeEvidence()
    : openEvidence();
$("team-evidence-close").onclick = closeEvidence;
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeEvidence();
    $<HTMLDetailsElement>("team-config").open = false;
  }
});
let loadStart = performance.now();
const loadTimer = setInterval(() => {
  $("load-elapsed").textContent =
    `${((performance.now() - loadStart) / 1000).toFixed(1)} s elapsed. Computation stays on this device.`;
}, 250);
function fail(message: string) {
  worker?.terminate();
  worker = null;
  $("team-load").hidden = false;
  $("team-ready").hidden = true;
  $("load-title").textContent = "Replay unavailable";
  $("load-message").textContent = message;
  $("team-cancel").hidden = true;
  $("team-retry").hidden = false;
}
$("team-cancel").onclick = () =>
  fail(
    "Computation canceled. Retry starts a fresh local worker with the same deterministic mission.",
  );
$("team-retry").onclick = () => startWorker();
function startWorker() {
  worker?.terminate();
  loadStart = performance.now();
  $("team-cancel").hidden = false;
  $("team-retry").hidden = true;
  $("load-title").textContent =
    `Preparing a ${choice.fleet === 3 ? "three" : "two"}-drone replay`;
  $("load-message").textContent =
    `Computing ${choice.fleet === 3 ? "all three" : "both"} drones for ${choice.duration} s in a local worker. You can cancel or change the mission.`;
  worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });
  const current = worker;
  current.onerror = (e) => {
    if (worker === current)
      fail(e.message || "Local worker failed. Retry the mission.");
  };
  current.onmessage = async (event) => {
    if (worker !== current) return;
    if (event.data.type === "progress") {
      $("load-message").textContent = event.data.text;
      return;
    }
    if (event.data.type === "error") {
      fail(event.data.message);
      return;
    }
    if (event.data.type !== "ready") return;
    let installed = false;
    try {
      const publicScenario = (
        choice.fleet === 3 ? buildThreePublicScenario : buildPublicScenario
      )(220000 + choice.index, choice.family);
      const mapHash = await mapFingerprint(publicScenario);
      if (worker !== current) return;
      if (mapHash !== event.data.fingerprint)
        throw Error(
          "Public map fingerprint mismatch. Replay was not rendered.",
        );
      const received = event.data.timeline as ReplayTimeline;
      validateReplayHorizon(received, choice.duration);
      validateReplayFleet(
        received,
        choice.fleet,
        choice.arm,
        publicScenario.world,
      );
      const receivedDigest = await digest(deterministicReplay(received));
      if (worker !== current) return;
      if (receivedDigest !== event.data.timelineDigest)
        throw Error(
          "Timeline transport digest mismatch. Replay was not rendered.",
        );
      if (worker !== current) return;
      verifiedMap = mapHash;
      timeline = received;
      computeMs = event.data.computeMs;
      timelineDigest = event.data.timelineDigest;
      current.terminate();
      worker = null;
      installed = true;
      clearInterval(loadTimer);
      $("team-load").hidden = true;
      $("team-ready").hidden = false;
      fitViews();
      const container = document.createElement("div");
      container.id = "stage";
      document.body.prepend(container);
      focusTimelines = ids.map((id) =>
        spectatorTimeline(timeline!, publicScenario, id),
      );
      stage = new Stage(container, focusTimelines[0]);
      stage.groundLookAtSubject = true;
      stage.showPrediction = false;
      stage.showObservationHistory = false;
      stage.showSearchMarkers = false;
      setFocus();
      stage.seeThrough = $<HTMLInputElement>("team-cutaway").checked;
      stage.showTruth = $<HTMLInputElement>("team-truth").checked;
      stage.showFrustum = $<HTMLInputElement>("team-frustum").checked;
      const extraCameras = ids.slice(1).map((id) => {
        const camera = new THREE.PerspectiveCamera(
          (2 * CAMERA.vHalf * 180) / Math.PI,
          CAMERA.aspect,
          0.3,
          260,
        );
        camera.layers.set(0);
        return { id, camera };
      });
      const map = new TeamMap(
          publicScenario.world,
          choice.fleet === 3
            ? new ThreeGeometry(publicScenario.world)
            : undefined,
        ),
        prior = Array.from(map.prior(publicScenario.prior));
      const overlays = new TeamOverlays(
        map.cells,
        publicScenario.world.heightAt,
      );
      stage.scene.add(overlays.root);
      const latest = new Map<
          SensorId,
          ReplayFrame["aircraft"][number]["observation"]
        >(),
        fixes: (typeof latest)[] = [];
      for (const f of timeline.frames) {
        for (const a of f.aircraft)
          if (a.observation) latest.set(a.id, a.observation);
        fixes.push(new Map(latest));
      }
      setCamera(mode);
      for (const id of ["team-play", "team-restart", "team-scrub"])
        $<HTMLButtonElement | HTMLInputElement>(id).disabled = false;
      $("team-provenance").textContent =
        `Map SHA-256 ${verifiedMap.slice(0, 16)}... / numeric replay ${timelineDigest.slice(0, 16)}... / development seeds ${220000 + choice.index} and ${225000 + choice.index}.`;
      $("team-outcome").textContent =
        `Whole replay, evaluation only: ${timeline.metrics.totalNoFixS.toFixed(2)} s with no accepted observation from ${choice.fleet === 3 ? "any drone" : "either drone"}; ${timeline.metrics.initialAcquired ? `first sighting at ${timeline.metrics.initialAcquisitionS.toFixed(2)} s` : `no sighting during ${choice.duration} s`}. These are one mission's outcomes, not a benchmark claim.`;
      last = performance.now();
      function drawMap(id: string, probability: number[], frame: ReplayFrame) {
        const canvas = $<HTMLCanvasElement>(`map-${id}`),
          ctx = canvas.getContext("2d")!,
          size = canvas.width;
        ctx.clearRect(0, 0, size, size);
        ctx.fillStyle = "#10212a";
        ctx.fillRect(0, 0, size, size);
        const max = Math.max(...probability, 1e-12);
        for (let k = 0; k < map.cells.length; k++) {
          const c = map.cells[k];
          if (!c.valid) continue;
          const alpha = 0.07 + 0.8 * Math.sqrt(probability[k] / max);
          ctx.fillStyle = `rgba(96,208,178,${alpha})`;
          ctx.fillRect((k % GRID.n) * 8, Math.floor(k / GRID.n) * 8, 8, 8);
        }
        const xy = (x: number, z: number) => [
          ((x + GRID.half) / (GRID.half * 2)) * size,
          ((z + GRID.half) / (GRID.half * 2)) * size,
        ];
        ctx.fillStyle = "#07151c80";
        for (const tree of publicScenario.world.trees) {
          if (tree.trunkR <= 0) continue;
          const [x, y] = xy(tree.x, tree.z);
          ctx.fillRect(x, y, 1, 1);
        }
        ctx.strokeStyle = "#c0d6db80";
        ctx.lineWidth = 1;
        ctx.strokeRect(
          ((publicScenario.prior.minX + 96) / 192) * size,
          ((publicScenario.prior.minZ + 96) / 192) * size,
          ((publicScenario.prior.maxX - publicScenario.prior.minX) / 192) *
            size,
          ((publicScenario.prior.maxZ - publicScenario.prior.minZ) / 192) *
            size,
        );
        for (const a of frame.aircraft) {
          const [x, y] = xy(a.state.pos.x, a.state.pos.z);
          ctx.fillStyle =
            a.id === "A" ? "#f8e0a1" : a.id === "B" ? "#82baff" : "#c59aff";
          ctx.beginPath();
          ctx.arc(x, y, 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.font = "10px monospace";
          ctx.fillText(a.id, x + 5, y + 3);
        }
        if (stage!.showTruth) {
          const [x, y] = xy(frame.subject.x, frame.subject.z);
          ctx.strokeStyle = "#ff7d99";
          ctx.lineWidth = 2;
          ctx.strokeRect(x - 3, y - 3, 6, 6);
        }
      }
      function tick(now: number) {
        if (!stage || !timeline) return;
        const elapsed = Math.max(0, (now - last) / 1000);
        last = now;
        if (!document.hidden) {
          frameIntervals.push(elapsed * 1000);
          maximumFrameIntervalMs = Math.max(
            maximumFrameIntervalMs,
            elapsed * 1000,
          );
          if (frameIntervals.length > 300) frameIntervals.shift();
        }
        if (playing && !document.hidden)
          time = Math.min(
            choice.duration,
            time + Math.min(elapsed, 0.1) * speed,
          );
        if (time >= choice.duration) playing = false;
        const frameIndex = displayFrameIndex(time, timeline.frames.length),
          i = Math.min(timeline.frames.length - 2, frameIndex),
          u = Math.max(0, Math.min(1, time / 0.05 - i)),
          frame = timeline.frames[frameIndex];
        stage.update(time, playing ? Math.min(elapsed, 0.1) : 0);
        for (const { id, camera } of extraCameras) {
          const a = timeline.frames[i].aircraft.find((a) => a.id === id)!.state,
            b = timeline.frames[i + 1].aircraft.find((a) => a.id === id)!.state;
          const pos = {
              x: lerp(a.pos.x, b.pos.x, u),
              y: lerp(a.pos.y, b.pos.y, u),
              z: lerp(a.pos.z, b.pos.z, u),
            },
            yaw = lerpAngle(a.camYaw, b.camYaw, u),
            pitch = lerp(a.camPitch, b.camPitch, u),
            fwd = forward(yaw, pitch);
          camera.position.set(pos.x, pos.y, pos.z);
          camera.lookAt(pos.x + fwd.x, pos.y + fwd.y, pos.z + fwd.z);
          if (id === "B")
            stage.updateSecondaryDrone(pos, lerpAngle(a.yaw, b.yaw, u), time, {
              yaw,
              pitch,
            });
          else
            stage.updateThirdDrone(pos, lerpAngle(a.yaw, b.yaw, u), time, {
              yaw,
              pitch,
            });
        }
        let epoch = timeline.beliefEpochs[0];
        for (const e of timeline.beliefEpochs) {
          if (e.t > time) break;
          epoch = e;
        }
        const hasEpoch = !!epoch && epoch.t <= time;
        const selectedProbability = hasEpoch
          ? (shared
              ? epoch.sensors[0]
              : epoch.sensors.find((s) => s.id === focus)
            )?.probability
          : undefined;
        const subjectLabel = $("team-subject-state");
        subjectLabel.hidden = !(choice.fleet === 3 && stage.showTruth);
        if (choice.fleet === 3 && "behavior" in frame.subject) {
          const labels: Record<string, string> = {
            travel: "Moving to a destination",
            "approach-cover": "Moving to cover",
            lowering: "Lowering into cover",
            "holding-cover": "Holding a cover attempt",
            repositioning: "Repositioning",
            "route-blocked": "Local route attempt paused",
          };
          subjectLabel.textContent = `Evaluation only: ${labels[String(frame.subject.behavior)] ?? "Recorded subject behavior"}. This is intent, not proof of invisibility.`;
        }
        const presentationDrones = frame.aircraft.map((d) => ({
          id: d.id,
          pos: d.state.pos,
          track: d.ownTrack,
          observation: d.observation,
        }));
        overlays.update({
          t: time,
          focus,
          shared,
          epoch:
            hasEpoch && selectedProbability
              ? { t: epoch.t, probability: selectedProbability }
              : null,
          drones: presentationDrones,
          allocations: frame.allocations,
          flags: analysisFlags,
        });
        let latestPlan: (typeof timeline.decisions)[number] | undefined;
        for (const decision of timeline.decisions) {
          if (decision.t > time) break;
          latestPlan = decision;
        }
        $("team-overlay-source").textContent =
          `${shared ? "Shared posterior / all active sources" : `Drone ${focus} posterior`} / ${hasEpoch ? `epoch age ${(time - epoch.t).toFixed(1)} s` : "no recorded epoch yet"}. Own prediction: Drone ${focus}. ${latestPlan ? `Recorded plan age ${(time - latestPlan.t).toFixed(1)} s.` : "No recorded plan yet."}`;
        stage.render(
          $("sensor-A").getBoundingClientRect(),
          extraCameras.map(({ id, camera }) => ({
            rect: $("sensor-" + id).getBoundingClientRect(),
            camera,
          })),
          root.getBoundingClientRect(),
        );
        for (const d of presentationDrones) {
          const marker = $(`annotation-${d.id}`);
          const own = annotationPoint(d, publicScenario.world.heightAt);
          const camera =
            d.id === "A"
              ? stage.insetCam
              : extraCameras.find((c) => c.id === d.id)!.camera;
          const projected =
            analysisFlags.annotations && own
              ? projectAnnotation(own.point, camera)
              : null;
          marker.hidden = !projected;
          if (projected && own) {
            marker.style.left = `${projected.x * 100}%`;
            marker.style.top = `${projected.y * 100}%`;
            marker.classList.toggle("is-prediction", own.prediction);
            if (choice.fleet === 2)
              marker.querySelector("span")!.textContent = own.prediction
                ? "Predicted position / no fix"
                : "Own noisy report";
            marker.dataset.source = d.id;
          }
        }
        if (!firstFrameMs) firstFrameMs = performance.now() - startup;
        for (const aircraft of frame.aircraft) {
          const id = aircraft.id,
            obs = aircraft.observation,
            track = aircraft.ownTrack,
            fix = fixes[frame.i].get(id),
            allocation = frame.allocations.find((a) => a.id === id),
            recovery = frame.recovery.find((r) => r.id === id);
          $(`sensor-status-${id}`).textContent = obs
            ? "Fix accepted now"
            : !track.initialised
              ? "Searching / no accepted fix yet"
              : `No fix now / last ${track.age.toFixed(1)} s ago`;
          $(`sensor-flight-${id}`).textContent =
            `${(aircraft.state.pos.y - publicScenario.world.heightAt(aircraft.state.pos.x, aircraft.state.pos.z)).toFixed(1)} m AGL / ${Math.hypot(aircraft.state.vel.x, aircraft.state.vel.z).toFixed(1)} m/s`;
          $(`gps-${id}`).textContent =
            `Simulated GPS (recorded pose): ${simulatedGpsText({ x: aircraft.state.pos.x, z: aircraft.state.pos.z })}. Local (${aircraft.state.pos.x.toFixed(1)}, ${aircraft.state.pos.z.toFixed(1)}) m.`;
          $(`evidence-${id}`).textContent = fix
            ? `Latest source Drone ${id} observation: Simulated GPS (reported): ${simulatedGpsText({ x: fix.x, z: fix.z })}; local (${fix.x.toFixed(1)}, ${fix.z.toFixed(1)}) m, noise sigma ${fix.sigma.toFixed(2)} m, age ${Math.max(0, time - fix.t).toFixed(1)} s.`
            : `Source ${id}: no accepted position observation yet.`;
          const assist =
            "assist" in frame
              ? frame.assist?.find((a) => a.id === id)
              : undefined;
          const task =
            "viewTasks" in frame
              ? frame.viewTasks.find((task) => task.id === id)
              : undefined;
          $(`assist-${id}`).textContent = assist
            ? `${assist.state === "investigating" ? "" : "Last assist result: "}${assist.reason}.${assist.source ? ` Source Drone ${assist.source}, report age ${Math.max(0, time - (assist.sensedAt ?? time)).toFixed(1)} s; Simulated GPS (reported): ${simulatedGpsText({ x: assist.x ?? NaN, z: assist.z ?? NaN })}; noisy local map position (${assist.x?.toFixed(1)}, ${assist.z?.toFixed(1)}) m, observation sigma ${assist.sigma?.toFixed(2)} m.${assist.uncertaintyM !== undefined ? ` View-selection uncertainty extent ${assist.uncertaintyM.toFixed(2)} m at its last planning update (heuristic age expansion).` : ""}` : ""}`
            : shared
              ? "No teammate investigation active."
              : "Teammate assistance is disabled in this independent policy.";
          if (choice.fleet === 3) {
            $(`assist-${id}`).textContent = task
              ? `View task: ${task.state}. ${task.reason}. Own camera confirmation: ${task.ownConfirmed ? "recent own fix" : "not confirmed"}. Fused public estimate: Simulated GPS ${simulatedGpsText(task.estimate)}; local (${task.estimate.x.toFixed(1)}, ${task.estimate.z.toFixed(1)}) m, heuristic radius ${task.estimate.radius.toFixed(1)} m at ${task.estimate.t.toFixed(1)} s. Sources: ${task.estimate.sources.map((source) => `Drone ${source.id}, report age ${Math.max(0, time - source.sensedAt).toFixed(1)} s, observation sigma ${source.sigma.toFixed(2)} m`).join("; ")}.`
              : shared
                ? "No joint view task active."
                : "Target observations are not shared in this independent policy.";
          }
          $(`intent-${id}`).textContent = allocation
            ? `Last allocation: ${allocation.reason}. ${assist?.state === "investigating" ? `Geometric uncertainty-sample visibility ${((assist.sampledSupport ?? 0) * 100).toFixed(0)}% (heuristic);` : `Expected visible model mass ${(allocation.mass * 100).toFixed(1)}%;`} route estimate ${allocation.routeMeters.toFixed(1)} m. Current mode ${aircraft.state.mode}.`
            : `Scanning the designated public start region. Current mode ${aircraft.state.mode}.`;
          $(`recovery-${id}`).textContent =
            recovery && recovery.state !== "clear"
              ? `${recovery.state === "blocked" ? "Local attempt paused" : recovery.state === "waiting" ? "Waiting for teammate clearance" : "Local detour"}: ${recovery.reason}.`
              : frame.heldIds.includes(id)
                ? "Safety hold on this interval."
                : "Motion: recorded controller and local clearance guard.";
        }
        $("belief-age").textContent = hasEpoch
          ? `Recorded belief epoch ${epoch.t.toFixed(1)} s / age ${(time - epoch.t).toFixed(1)} s. ${shared ? "All active sources contribute to this one estimate." : "Each drone uses only its own evidence."}`
          : "Public initial region prior. No recorded belief epoch yet.";
        if (shared)
          drawMap(
            "shared",
            hasEpoch ? epoch.sensors[0].probability : prior,
            frame,
          );
        else
          for (const id of ids)
            drawMap(
              id,
              hasEpoch
                ? epoch.sensors.find((s) => s.id === id)!.probability
                : prior,
              frame,
            );
        syncPlayback();
        if (now - lastUrl > 2000) {
          storeUrl();
          lastUrl = now;
        }
        const sorted = [...frameIntervals].sort((a, b) => a - b),
          p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
        $("team-performance").textContent =
          `Local worker compute ${computeMs.toFixed(0)} ms; first rendered frame ${firstFrameMs.toFixed(0)} ms including map reconstruction and scene startup. Recent frame interval p95 ${p95.toFixed(1)} ms; longest observed interval ${maximumFrameIntervalMs.toFixed(1)} ms (includes lazy spectator setup). Maximum recorded actual acceleration ${Number(timeline.diagnostics.maxActualAccelerationMps2).toFixed(1)} m/s².`;
        Object.assign(debug, {
          time,
          playing,
          speed,
          mode,
          focus,
          firstFrameMs,
          computeMs,
          frameP95Ms: p95,
          maximumFrameIntervalMs,
          analysisFlags: { ...analysisFlags },
          analysisRecord: {
            epoch: overlays.record.epoch,
            source: overlays.record.source,
            selectedCells: [...overlays.record.selectedCells],
          },
          spectatorClearanceFailures: stage.spectatorClearanceFailures,
          overlayLayersValid: (() => {
            let valid = true;
            overlays.root.traverse((o) => {
              if (o.layers.mask !== 2) valid = false;
            });
            return valid;
          })(),
        });
        requestAnimationFrame(tick);
      }
      Object.assign(debug, {
        timeline,
        timelineDigest,
        mapFingerprint: verifiedMap,
        arm: choice.arm,
        family: choice.family,
        missionIndex: choice.index,
        duration: choice.duration,
        fleet: choice.fleet,
        policyVersion:
          "policyVersion" in timeline
            ? timeline.policyVersion
            : "preserved-two-drone",
        serializedBytes: event.data.serializedBytes,
        presentationCells: map.cells.map((c) => ({
          x: c.x,
          z: c.z,
          minX: c.minX,
          maxX: c.maxX,
          minZ: c.minZ,
          maxZ: c.maxZ,
          valid: c.valid,
        })),
      });
      requestAnimationFrame(tick);
    } catch (error) {
      if (worker === current || installed)
        fail(error instanceof Error ? error.message : String(error));
    }
  };
  current.postMessage({ query: query.toString() });
}
const debug: Record<string, unknown> = {};
Object.defineProperty(window, "__team", { value: debug });
window.addEventListener("beforeunload", () => worker?.terminate());
$("cutaway-label").textContent =
  `CUTAWAY: ${$<HTMLInputElement>("team-cutaway").checked ? "ON" : "OFF"}`;
syncPlayback();
storeUrl();
startWorker();
