/**
 * Render-only visualisation of the learned probability grid (+ calibrated 95% region, peaks) on the terrain and the minimap.
 * It reads the precomputed Timeline's belief records; it never feeds anything back into the simulation. Objects live on
 * layer 1 which only the main spectator camera renders, so the simulated drone-camera inset is unchanged.
 */
import * as THREE from "three";
import { findPeaks, entropyBits, hpdRegion, regionAreaM2, type BeliefGrid, type Peak } from "../ml/belief";
import { CELL_M, GRID_N, cellCentre } from "../ml/features";
import type { Sample } from "../sim/playback";
import type { Timeline } from "../sim/simulate";
import type { Stage } from "./stage";

export interface MlReadout { peaks: Peak[]; region95Cells: number; region95M2: number; entropyBits: number; elapsedS: number }

/** Peak-marker post height in metres (kept <= 1 m; a test enforces it). */
export const POST_HEIGHT_M = 0.9;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export class MlOverlay {
  show = true;
  private heat: THREE.Mesh;
  private heatPos = new Float32Array(GRID_N * GRID_N * 6 * 3);
  private heatCol = new Float32Array(GRID_N * GRID_N * 6 * 4);
  private outline: THREE.LineSegments;
  private outlinePos = new Float32Array(GRID_N * GRID_N * 4 * 2 * 3);
  private peakMarks: THREE.Group = new THREE.Group();
  private shown: BeliefGrid | null = null;
  current: BeliefGrid | null = null;
  readout: MlReadout | null = null;

  constructor(private stage: Stage, private tl: Timeline, private regionLevel: number) {
    const hg = new THREE.BufferGeometry();
    hg.setAttribute("position", new THREE.BufferAttribute(this.heatPos, 3));
    hg.setAttribute("color", new THREE.BufferAttribute(this.heatCol, 4));
    this.heat = new THREE.Mesh(hg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    this.heat.frustumCulled = false;
    this.heat.renderOrder = 4;
    const og = new THREE.BufferGeometry();
    og.setAttribute("position", new THREE.BufferAttribute(this.outlinePos, 3));
    this.outline = new THREE.LineSegments(og, new THREE.LineBasicMaterial({ color: 0xe9c6ff, transparent: true, opacity: 0.95, depthWrite: false, fog: false }));
    this.outline.frustumCulled = false;
    this.outline.renderOrder = 5;
    for (let k = 0; k < 3; k++) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.5, 2.2, 28), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false, fog: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.name = "ring";
      // Short ground post (<= 1 m): a subtle marker at the peak, not a tall pillar that dominates the scene.
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, POST_HEIGHT_M, 6), new THREE.MeshBasicMaterial({ color: 0xe9c6ff, transparent: true, opacity: 0.8, fog: false }));
      pole.position.y = POST_HEIGHT_M / 2;
      const g = new THREE.Group();
      g.add(ring, pole);
      g.visible = false;
      this.peakMarks.add(g);
    }
    for (const o of [this.heat, this.outline, this.peakMarks]) { o.layers.set(1); o.traverse((c) => c.layers.set(1)); }
    stage.camera.layers.enable(1);
    stage.scene.add(this.heat, this.outline, this.peakMarks);
    this.heat.visible = this.outline.visible = this.peakMarks.visible = false;
  }

  /** Belief that applies at frame index i: the latest fixed-step prediction tick (null when the fix is present). */
  beliefAt(i: number): BeliefGrid | null {
    const ml = this.tl.ml;
    if (!ml) return null;
    return ml.beliefs[Math.floor(i / ml.stride)] ?? null;
  }

  private build(b: BeliefGrid): void {
    const w = this.tl.world;
    let pmax = 0;
    for (const p of b.prob) pmax = Math.max(pmax, p);
    const region = hpdRegion(b, this.regionLevel);
    const lift = 0.35;
    let pi = 0, ci = 0, oi = 0;
    const H = (x: number, z: number) => w.heightAt(x, z) + lift;
    for (let i = 0; i < GRID_N; i++) for (let j = 0; j < GRID_N; j++) {
      const c = cellCentre(b.center, i, j), h = CELL_M / 2;
      const x0 = c.x - h, x1 = c.x + h, z0 = c.z - h, z1 = c.z + h;
      const quad = [[x0, z0], [x1, z0], [x1, z1], [x0, z0], [x1, z1], [x0, z1]];
      const p = b.prob[i * GRID_N + j];
      const rel = Math.sqrt(p / (pmax || 1));
      const a = p / (pmax || 1) < 0.01 ? 0 : 0.12 + 0.43 * rel;
      for (const [x, z] of quad) {
        this.heatPos[pi++] = x; this.heatPos[pi++] = H(x, z); this.heatPos[pi++] = z;
        this.heatCol[ci++] = 0.86; this.heatCol[ci++] = 0.25 + 0.45 * rel; this.heatCol[ci++] = 0.98; this.heatCol[ci++] = a;
      }
      if (region.mask[i * GRID_N + j]) {
        const edge = (ni: number, nj: number) => ni < 0 || nj < 0 || ni >= GRID_N || nj >= GRID_N || !region.mask[ni * GRID_N + nj];
        const seg = (ax: number, az: number, bx: number, bz: number) => {
          this.outlinePos[oi++] = ax; this.outlinePos[oi++] = H(ax, az) + 0.1; this.outlinePos[oi++] = az;
          this.outlinePos[oi++] = bx; this.outlinePos[oi++] = H(bx, bz) + 0.1; this.outlinePos[oi++] = bz;
        };
        if (edge(i - 1, j)) seg(x0, z0, x1, z0);
        if (edge(i + 1, j)) seg(x0, z1, x1, z1);
        if (edge(i, j - 1)) seg(x0, z0, x0, z1);
        if (edge(i, j + 1)) seg(x1, z0, x1, z1);
      }
    }
    (this.heat.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.heat.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (this.outline.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.outline.geometry.setDrawRange(0, oi / 3);
    const peaks = findPeaks(b, 3, 2, 0.05);
    this.peakMarks.children.forEach((g, k) => {
      const pk = peaks[k];
      g.visible = !!pk;
      if (pk) {
        g.position.set(pk.x, w.heightAt(pk.x, pk.z) + 0.5, pk.z);
        const s = 0.8 + 2.2 * Math.sqrt(pk.mass);
        g.getObjectByName("ring")!.scale.set(s, s, s);
      }
    });
    this.readout = { peaks, region95Cells: region.cells, region95M2: regionAreaM2(region.cells), entropyBits: entropyBits(b), elapsedS: b.elapsed };
  }

  update(smp: Sample): void {
    const b = this.beliefAt(smp.a.i);
    this.current = b;
    if (b !== this.shown) { this.shown = b; if (b) this.build(b); else this.readout = null; }
    const vis = !!b && this.show && this.stage.showPrediction;
    this.heat.visible = this.outline.visible = this.peakMarks.visible = vis;
    this.heat.visible = vis;
    this.readoutDom(b);
  }

  private readoutDom(b: BeliefGrid | null): void {
    const dl = $("ml-readout");
    dl.hidden = false;
    const r = this.readout;
    $("ml-peaks").textContent = b && r ? r.peaks.map((p, k) => `#${k + 1} ${(p.mass * 100).toFixed(0)}%`).join(" · ") || "—" : "— (fix present)";
    $("ml-region").textContent = b && r ? `${Math.round(r.region95M2).toLocaleString("en-US")} m² · ≈${Math.sqrt(r.region95M2 / Math.PI).toFixed(0)} m radius` : "—";
    $("ml-entropy").textContent = b && r ? `${r.entropyBits.toFixed(1)} bits` : "—";
  }

  /** Minimap overlay: call after Hud.update (which redraws the map every frame). */
  drawMinimap(): void {
    const b = this.current;
    if (!b || !this.show || !this.stage.showPrediction) return;
    const cv = $("minimap") as HTMLCanvasElement;
    if (cv.classList.contains("off")) return;
    const c = cv.getContext("2d")!, n = cv.width, half = this.tl.world.half;
    const px = (x: number) => ((x + half) / (2 * half)) * n, py = (z: number) => (1 - (z + half) / (2 * half)) * n;
    let pmax = 0;
    for (const p of b.prob) pmax = Math.max(pmax, p);
    const cs = (CELL_M / (2 * half)) * n;
    for (let i = 0; i < GRID_N; i++) for (let j = 0; j < GRID_N; j++) {
      const p = b.prob[i * GRID_N + j] / (pmax || 1);
      if (p < 0.01) continue;
      const cc = cellCentre(b.center, i, j);
      c.fillStyle = `rgba(220,${Math.round(64 + 110 * Math.sqrt(p))},250,${(0.2 + 0.6 * Math.sqrt(p)).toFixed(2)})`;
      c.fillRect(px(cc.x) - cs / 2, py(cc.z) - cs / 2, cs + 0.5, cs + 0.5);
    }
    c.strokeStyle = "#fff"; c.lineWidth = 2; c.font = "bold 16px sans-serif"; c.fillStyle = "#fff";
    (this.readout?.peaks ?? []).forEach((p, k) => { c.beginPath(); c.arc(px(p.x), py(p.z), 9, 0, 7); c.stroke(); c.fillText(String(k + 1), px(p.x) + 11, py(p.z) - 8); });
  }
}
