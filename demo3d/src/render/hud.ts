import { DRONE } from "../sim/drone";
import { CAMERA, fovTest } from "../sim/sensor";
import { ACTION_LABEL } from "../sim/subject";
import { canopyBands, type Timeline } from "../sim/simulate";
import type { Sample } from "../sim/playback";
import type { Frame, TrackStatus, VisibilityReason } from "../sim/types";
import { STATUS_COLOR, type Stage } from "./stage";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const hex = (c: number) => "#" + c.toString(16).padStart(6, "0");

const REASON: Record<VisibilityReason, [string, boolean]> = {
  VISIBLE: ["clear", true],
  OCCLUDED_CANOPY: ["blocked · canopy", false],
  OCCLUDED_TRUNK: ["blocked · trunk", false],
  OCCLUDED_TERRAIN: ["blocked · terrain", false],
  OUT_OF_RANGE: ["—", true],
  OUT_OF_FOV: ["—", true],
};

export function caption(f: Frame, layerTop: number): string {
  const s: TrackStatus = f.track.status;
  if (s === "TRACKING" && f.mode === "FOLLOW_HIGH") return "Tracking: subject in view. Drone cruises above the canopy.";
  if (s === "TRACKING" && f.mode === "CLIMB") return "Track held. Drone climbing back toward cruise altitude.";
  if (s === "TRACKING" && f.mode === "FOLLOW_LOW") return "Track confirmed. Following low, below the canopy.";
  if (s === "TRACKING") return "Tracking: subject in view.";
  if (s === "COASTING") return "Subject out of view. Coasting on the prediction while the fix is missing.";
  if (s === "REACQUIRING") return "Subject seen again. Confirming the track with consecutive fixes…";
  return f.drone.agl > layerTop
    ? "Subject lost: prediction only, uncertainty growing. Drone descends to look beneath the canopy."
    : "Searching low and moving sideways around the predicted area, looking under the canopy.";
}

export class Hud {
  private lastEv = -1;
  private toastTimer = 0;
  private trailCache: HTMLCanvasElement | null = null;
  private layerTop: number;
  showMap = true;

  constructor(private tl: Timeline, private stage: Stage) {
    const b = canopyBands(tl.world);
    this.layerTop = b.layerTop;
    const gb = $("g-band");
    gb.style.bottom = (b.bottom / 30) * 100 + "%";
    gb.style.height = ((b.layerTop - b.bottom) / 30) * 100 + "%";
    const dur = tl.frames[tl.frames.length - 1].t;
    const host = $("markers"), chips = $("chips");
    tl.events.forEach((e, k) => {
      const tick = document.createElement("div");
      tick.className = "tick";
      tick.style.left = (e.t / dur) * 100 + "%";
      host.appendChild(tick);
      const c = document.createElement("button");
      c.className = "chip2";
      c.dataset.t = String(e.t);
      c.innerHTML = `<b>${k + 1}</b> ${e.label} <i>${e.t.toFixed(1)}s</i>`;
      chips.appendChild(c);
    });
  }

  update(smp: Sample, playing: boolean): void {
    const f = smp.a;
    const st = f.track.status;
    const chip = $("chip");
    chip.textContent = st;
    chip.style.background = hex(STATUS_COLOR[st]);
    $("caption").textContent = caption(f, this.layerTop);
    $("v-mode").textContent = f.mode.replace("_", " ");
    $("v-agl").textContent = f.drone.agl.toFixed(1) + " m";
    $("v-speed").textContent = Math.hypot(f.drone.vx, f.drone.vz).toFixed(1) + " m/s";
    $("v-age").textContent = f.track.age.toFixed(1) + " s";
    $("v-rad").textContent = f.track.initialised ? "±" + f.track.radius.toFixed(1) + " m" : "—";
    const [txt, ok] = REASON[f.visibility];
    const los = $("v-los");
    const cam = { x: f.drone.x, y: f.drone.y, z: f.drone.z };
    const tp = { x: f.subject.x, y: f.subject.y + DRONE.targetHeight, z: f.subject.z };
    const fov = fovTest(cam, f.cam.yaw, f.cam.pitch, tp);
    const blockedKnown = f.visibility.startsWith("OCCLUDED");
    los.textContent = f.visibility === "OUT_OF_RANGE" || f.visibility === "OUT_OF_FOV" ? "not evaluated" : txt;
    los.className = blockedKnown ? "bad" : f.visibility === "VISIBLE" ? "good" : "";
    void ok;
    $("v-fov").textContent = fov.inFov ? "yes" : "no";
    $("v-fov").className = fov.inFov ? "good" : "bad";
    $("v-range").textContent = fov.range.toFixed(0) + " m / " + CAMERA.maxRange + " m";
    $("v-range").className = fov.inRange ? "good" : "bad";

    // evaluation-only: the subject's true action, shown only when the ground-truth marker is on
    $("subj-eval-dt").hidden = $("v-sact").hidden = !this.stage.showTruth;
    if (this.stage.showTruth) {
      $("v-sact").textContent = ACTION_LABEL[f.subject.action] + " · " + f.subject.speed.toFixed(1) + " m/s";
    }

    const g = $("g-drone");
    g.style.bottom = Math.min(f.drone.agl / 30, 1) * 100 + "%";

    // drone-cam inset overlay
    const inset = $("inset");
    inset.classList.toggle("lost", st !== "TRACKING");
    $("ins-status").textContent = f.visibility === "VISIBLE" ? "TARGET IN VIEW" : "NO TARGET";
    const lock = $("lock"), ghost = $("pred-ghost");
    lock.style.display = ghost.style.display = "none";
    const w = this.tl.world;
    const place = (el: HTMLElement, x: number, y: number, z: number) => {
      const p = this.stage.insetProject(x, y, z);
      if (!p) return false;
      el.style.left = p.u * 100 + "%"; el.style.top = p.v * 100 + "%"; el.style.display = "block";
      return true;
    };
    if (f.obs) place(lock, f.obs.x, w.heightAt(f.obs.x, f.obs.z) + 1, f.obs.z);
    else if (f.track.initialised) place(ghost, f.track.x, w.heightAt(f.track.x, f.track.z) + 1, f.track.z);
    $("ins-msg").textContent = f.obs ? "LOCK · fix " + f.obs.sigma.toFixed(1) + " m σ" : f.track.initialised ? "PREDICTED POSITION (dashed) — no fix" : "";

    // timeline
    const dur = this.tl.frames[this.tl.frames.length - 1].t;
    ($("scrub") as HTMLInputElement).value = String(Math.round((smp.t / dur) * 10000));
    $("time").textContent = smp.t.toFixed(1) + " / " + dur.toFixed(1) + " s";
    $("b-play").textContent = playing ? "⏸" : "▶";
    $("b-restart").classList.toggle("pulse", !playing && smp.t >= dur - 1e-6);

    const chipEls = $("chips").children;
    this.tl.events.forEach((e, k) => chipEls[k].classList.toggle("past", smp.t >= e.t));
    // event toasts (only when time passes a marker going forward)
    const idx = this.tl.events.findIndex((e) => e.t > smp.t) - 1;
    const cur = idx === -2 ? this.tl.events.length - 1 : idx;
    if (cur !== this.lastEv) {
      if (cur > this.lastEv && playing && cur >= 0) this.toast(this.tl.events[cur].label);
      this.lastEv = cur;
    }
    if (this.showMap) this.drawMap(smp);
  }

  private toast(msg: string): void {
    const t = $("toast");
    t.textContent = msg.toUpperCase();
    t.classList.add("show");
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove("show"), 2400);
  }

  private mapXY(x: number, z: number, n: number): [number, number] {
    const h = this.tl.world.half;
    return [((x + h) / (2 * h)) * n, (1 - (z + h) / (2 * h)) * n];
  }

  private drawMap(smp: Sample): void {
    const cv = $("minimap") as HTMLCanvasElement;
    const n = cv.width;
    const c = cv.getContext("2d")!;
    if (!this.trailCache) {
      const bg = document.createElement("canvas");
      bg.width = bg.height = n;
      const b = bg.getContext("2d")!;
      b.fillStyle = "#16241a"; b.fillRect(0, 0, n, n);
      for (const t of this.tl.world.trees) {
        const [x, y] = this.mapXY(t.x, t.z, n);
        b.fillStyle = t.grove ? "rgba(40,120,60,0.9)" : "rgba(60,110,60,0.55)";
        b.beginPath(); b.arc(x, y, Math.max(1.5, (t.canopyR / 190) * n), 0, 7); b.fill();
      }
      this.trailCache = bg;
    }
    c.drawImage(this.trailCache, 0, 0);
    const fr = this.tl.frames;
    // observed trail (what the tracker actually received)
    c.strokeStyle = "#39e08f"; c.lineWidth = 3; c.beginPath();
    let pen = false;
    for (let i = 0; i <= smp.a.i; i++) {
      if (!fr[i].obs) { pen = false; continue; }
      const [x, y] = this.mapXY(fr[i].track.x, fr[i].track.z, n);
      if (!pen) c.moveTo(x, y); else c.lineTo(x, y);
      pen = true;
    }
    c.stroke();
    const f = smp.a;
    if (f.track.initialised) {
      const [bx, by] = this.mapXY(f.track.x, f.track.z, n);
      const r = Math.min((f.track.radius / (2 * this.tl.world.half)) * n, n * 0.4);
      c.fillStyle = hex(STATUS_COLOR[f.track.status]) + "44"; c.strokeStyle = hex(STATUS_COLOR[f.track.status]); c.lineWidth = 2;
      c.beginPath(); c.arc(bx, by, Math.max(r, 3), 0, 7); c.fill(); c.stroke();
    }
    const [dx, dy] = this.mapXY(f.drone.x, f.drone.z, n);
    const a = f.cam.yaw;
    c.fillStyle = "rgba(255,255,255,0.18)"; c.beginPath(); c.moveTo(dx, dy);
    const hh = CAMERA.hHalf, L = 60;
    c.lineTo(dx + Math.sin(a - hh) * L, dy - Math.cos(a - hh) * L); c.lineTo(dx + Math.sin(a + hh) * L, dy - Math.cos(a + hh) * L); c.fill();
    c.fillStyle = "#47c8ff"; c.beginPath(); c.arc(dx, dy, 6, 0, 7); c.fill();
    if (this.stage.showTruth) {
      const [sx, sy] = this.mapXY(f.subject.x, f.subject.z, n);
      c.strokeStyle = "#fff"; c.lineWidth = 2; c.strokeRect(sx - 6, sy - 6, 12, 12);
      c.fillStyle = "#fff"; c.font = "bold 18px sans-serif"; c.fillText("EVAL", sx + 9, sy - 8);
    }
  }
}
