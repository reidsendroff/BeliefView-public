/**
 * Rendering only. Reads a precomputed Timeline; never feeds anything back into the simulation.
 * Layer 0: the simulated world (trees, terrain, subject). Layer 1: overlays + the drone body
 * (hidden from the drone-camera inset so that inset shows only what the sensor could see).
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { projectClear, segmentHitsSphere } from "../sim/geometry";
import { lerp, lerpAngle, sampleAt, type Sample } from "../sim/playback";
import { CAMERA, forward } from "../sim/sensor";
import { Rng } from "../sim/rng";
import { DEFAULT_WAYPOINTS, distToPolyline, samplePath } from "../sim/route";
import { predictCorridor } from "../sim/tracker";
import { closeShotFocus, closeShotRig } from "./spectator";
import { foregroundObstacle } from "./cutaway";
import { isRichWorld, isCoverPrimitive } from "../sim/richWorld";
import type { Timeline } from "../sim/simulate";
import type { TrackStatus } from "../sim/types";
import { isThreeWorld } from "../team/threeWorld";
import { BODY_VERSION, type BodyInput } from "../team/threeBody";
import { ThreeBodyRig } from "./threeBodyRig";
import { ThreeForestSolids } from "./threeForest";
import { ThreeGeometry } from "../team/threeGeometry";

export type CameraMode = "cinematic" | "chase" | "ground" | "orbit";

export const STATUS_COLOR: Record<TrackStatus, number> = {
  TRACKING: 0x39e08f,
  COASTING: 0xffc247,
  SEARCHING: 0xff7a3d,
  REACQUIRING: 0x47c8ff,
};

const OVERLAY = 1;
/** Static dirt-trail art the world was generated around. NOT the subject's route: the subject is a free-roaming evasive agent. */
const TRAIL = samplePath(DEFAULT_WAYPOINTS);
const TRAIL_STEPS = 90; // footprint marks, one per 0.1 s of subject history

function terrainColor(h: number, n: number, dirt: number): THREE.Color {
  const c = new THREE.Color();
  const g = new THREE.Color(0x3e6b34).lerp(new THREE.Color(0x76934a), THREE.MathUtils.clamp((h + 3) / 9, 0, 1));
  g.lerp(new THREE.Color(0x2c4f2b), n * 0.5);
  c.copy(g).lerp(new THREE.Color(0x6b5a3f), dirt * 0.8);
  return c;
}

class Draped {
  readonly disc: THREE.Mesh;
  readonly ring: THREE.LineLoop;
  private pos: Float32Array;
  private ringPos: Float32Array;
  private seg = 64;
  constructor(color: number, private heightAt: (x: number, z: number) => number) {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array((this.seg + 1) * 3);
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    const idx: number[] = [];
    for (let i = 0; i < this.seg; i++) idx.push(0, 1 + i, 1 + ((i + 1) % this.seg));
    g.setIndex(idx);
    this.disc = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
    const rg = new THREE.BufferGeometry();
    this.ringPos = new Float32Array(this.seg * 3);
    rg.setAttribute("position", new THREE.BufferAttribute(this.ringPos, 3));
    this.ring = new THREE.LineLoop(rg, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 }));
    this.disc.frustumCulled = false; this.ring.frustumCulled = false;
    this.disc.layers.set(OVERLAY); this.ring.layers.set(OVERLAY);
  }
  setColor(c: number): void {
    (this.disc.material as THREE.MeshBasicMaterial).color.setHex(c);
    (this.ring.material as THREE.LineBasicMaterial).color.setHex(c);
  }
  set(x: number, z: number, r: number): void {
    this.pos[0] = x; this.pos[1] = this.heightAt(x, z) + 0.2; this.pos[2] = z;
    for (let i = 0; i < this.seg; i++) {
      const a = (i / this.seg) * Math.PI * 2;
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r, py = this.heightAt(px, pz) + 0.2;
      this.pos.set([px, py, pz], 3 + i * 3);
      this.ringPos.set([px, py + 0.05, pz], i * 3);
    }
    (this.disc.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.ring.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.disc.geometry.computeBoundingSphere();
  }
}

const CORRIDOR_STEPS = 28;
const CORRIDOR_HORIZON = 10;

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(52, 1, 0.3, 600);
  readonly insetCam = new THREE.PerspectiveCamera((2 * CAMERA.vHalf * 180) / Math.PI, CAMERA.aspect, 0.3, 260);
  readonly controls: OrbitControls;
  mode: CameraMode = "cinematic";
  groundLookAtSubject = false; // Team-only spectator framing; sensor cameras are unchanged.
  showTruth = false;
  showFrustum = true;
  showPrediction = true;
  showTrail = false; // evaluation-only: reveals true path; only drawn while showTruth is on

  private spectatorTimeline: Timeline | null = null;
  showObservationHistory = true;
  showSearchMarkers = true;
  setSpectatorTimeline(tl: Timeline | null):void {this.spectatorTimeline=tl;this.lastT=-1;}

  private secondaryDrone: THREE.Group | null = null;
  private secondaryRotors:THREE.Object3D[]=[];
  private thirdDrone: THREE.Group | null = null;
  private thirdRotors: THREE.Object3D[] = [];

  private sun = new THREE.DirectionalLight(0xffe2b0, 3.2);
  private subjectRig = new THREE.Group();
  private torso = new THREE.Group();
  private articulatedBody: ThreeBodyRig | null = null;
  private threeForest: ThreeForestSolids | null = null;
  private threeGeometry: ThreeGeometry | null = null;
  private lastClearSpectator: THREE.Vector3 | null = null;
  spectatorClearanceFailures = 0;
  private trail!: THREE.InstancedMesh;
  private legs: THREE.Object3D[] = [];
  private arms: THREE.Object3D[] = [];
  private droneRig = new THREE.Group();
  private rotors: THREE.Object3D[] = [];
  private gimbal = new THREE.Group();
  private frustum = new THREE.Group();
  private frustumLines!: THREE.LineSegments;
  private frustumFill!: THREE.Mesh;
  private beliefBeam: THREE.Mesh;
  private beliefMarker: THREE.Mesh;
  private beliefDraped: Draped;
  private corridor: THREE.Mesh;
  private corridorPos = new Float32Array((CORRIDOR_STEPS + 1) * 2 * 3);
  private corridorCol = new Float32Array((CORRIDOR_STEPS + 1) * 2 * 4);
  private centerLine: THREE.Line;
  private centerPos = new Float32Array((CORRIDOR_STEPS + 1) * 3);
  private obsTrail: THREE.LineSegments;
  private obsSegEnd: number[] = [];
  private viewpointMarker: THREE.Mesh;
  private viewpointLine: THREE.Line;
  private aimLine: THREE.Line;
  private truthGroup = new THREE.Group();
  private camPos = new THREE.Vector3(0, 40, -40);
  private camLook = new THREE.Vector3();
  private lastT = -1;
  private fadeAttr!: THREE.InstancedBufferAttribute;
  private fade!: Float32Array;
  private fadeUniform = { value: 1 };
  private trunkFade!: Float32Array;
  private trunkFadeAttr!: THREE.InstancedBufferAttribute;
  private coverFades: { indices:number[]; uniform:{value:number} }[]=[];
  cutawayCount=0;
  seeThrough = true;

  constructor(private container: HTMLElement, private tl: Timeline) {
    const world = tl.world;
    if(isThreeWorld(world)) this.threeGeometry=new ThreeGeometry(world);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.autoClear = true;
    container.appendChild(this.renderer.domElement);
    this.camera.layers.enable(OVERLAY);

    this.buildSky();
    this.buildTerrain();
    this.buildForest();
    this.buildRichCover();
    if (isThreeWorld(world)) { this.threeForest = new ThreeForestSolids(world, this.fadeUniform); this.scene.add(this.threeForest.root); }
    this.buildSubject();
    this.buildDrone();
    this.scene.add(this.subjectRig, this.droneRig);

    // belief / prediction overlays
    this.beliefDraped = new Draped(0xffc247, world.heightAt);
    this.scene.add(this.beliefDraped.disc, this.beliefDraped.ring);
    this.beliefBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 6, 10, 1, true), new THREE.MeshBasicMaterial({ color: 0xffc247, transparent: true, opacity: 0.55, depthWrite: false }));
    this.beliefMarker = new THREE.Mesh(new THREE.OctahedronGeometry(0.45), new THREE.MeshBasicMaterial({ color: 0xffc247 }));
    this.beliefBeam.layers.set(OVERLAY); this.beliefMarker.layers.set(OVERLAY);
    this.scene.add(this.beliefBeam, this.beliefMarker);

    const cg = new THREE.BufferGeometry();
    cg.setAttribute("position", new THREE.BufferAttribute(this.corridorPos, 3));
    cg.setAttribute("color", new THREE.BufferAttribute(this.corridorCol, 4));
    const ci: number[] = [];
    for (let i = 0; i < CORRIDOR_STEPS; i++) { const k = i * 2; ci.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    cg.setIndex(ci);
    this.corridor = new THREE.Mesh(cg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3 }));
    this.corridor.frustumCulled = false; this.corridor.layers.set(OVERLAY);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.BufferAttribute(this.centerPos, 3));
    this.centerLine = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xfff1c0, transparent: true, opacity: 0.9 }));
    this.centerLine.frustumCulled = false; this.centerLine.layers.set(OVERLAY);
    this.scene.add(this.corridor, this.centerLine);

    // observed track history (green): consecutive observations only
    const pts: number[] = [];
    const fr = tl.frames;
    for (let i = 1; i < fr.length; i++) {
      // drawn from the tracker's filtered estimate on frames where a fix was received
      const p = fr[i - 1].obs ? fr[i - 1].track : null, q = fr[i].obs ? fr[i].track : null;
      if (p && q) { pts.push(p.x, world.heightAt(p.x, p.z) + 0.35, p.z, q.x, world.heightAt(q.x, q.z) + 0.35, q.z); this.obsSegEnd.push(i); }
    }
    const og = new THREE.BufferGeometry();
    og.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
    this.obsTrail = new THREE.LineSegments(og, new THREE.LineBasicMaterial({ color: 0x39e08f, transparent: true, opacity: 0.85 }));
    this.obsTrail.frustumCulled = false; this.obsTrail.layers.set(OVERLAY);
    this.scene.add(this.obsTrail);

    this.viewpointMarker = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.09, 8, 28), new THREE.MeshBasicMaterial({ color: 0xff7a3d }));
    this.viewpointMarker.layers.set(OVERLAY);
    const vg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.viewpointLine = new THREE.Line(vg, new THREE.LineDashedMaterial({ color: 0xff7a3d, dashSize: 0.8, gapSize: 0.6, transparent: true, opacity: 0.8 }));
    this.viewpointLine.layers.set(OVERLAY); this.viewpointLine.frustumCulled = false;
    const ag = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.aimLine = new THREE.Line(ag, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
    this.aimLine.layers.set(OVERLAY); this.aimLine.frustumCulled = false;
    this.scene.add(this.viewpointMarker, this.viewpointLine, this.aimLine);

    this.buildTruthMarker();
    this.scene.add(this.truthGroup);

    this.controls = new OrbitControls(this.camera, document.getElementById("spectator-pane") ?? this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 160;
    this.controls.enabled = false;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  // ---------------------------------------------------------------- scene building
  private buildSky(): void {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(450, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: { top: { value: new THREE.Color(0x4f86c6) }, mid: { value: new THREE.Color(0xe9c99a) }, hor: { value: new THREE.Color(0xc4d6c9) }, sun: { value: new THREE.Vector3(-0.6, 0.45, -0.5).normalize() } },
        vertexShader: "varying vec3 v; void main(){ v = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} ",
        fragmentShader: "uniform vec3 top; uniform vec3 mid; uniform vec3 hor; uniform vec3 sun; varying vec3 v; void main(){ float h = clamp(v.y,0.0,1.0); vec3 c = mix(hor, mid, smoothstep(0.0,0.12,h)); c = mix(c, top, smoothstep(0.1,0.65,h)); float s = pow(max(dot(v,sun),0.0), 24.0); c += vec3(1.0,0.78,0.5)*s*0.6; gl_FragColor = vec4(c,1.0);} ",
      }),
    );
    this.scene.add(sky);
    this.scene.fog = new THREE.FogExp2(0xc4d6c9, 0.0075);
    this.scene.add(new THREE.HemisphereLight(0xbcd6ff, 0x3a4a2a, 1.15));
    this.sun.position.set(-60, 70, -45);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 10; sc.far = 260;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);
  }

  private buildTerrain(): void {
    const w = this.tl.world;
    const size = w.half * 2 + 60;
    const seg = 190;
    const g = new THREE.PlaneGeometry(size, size, seg, seg);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(p.count * 3);
    const poly = TRAIL;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const h = w.heightAt(x, z);
      p.setY(i, h);
      const n = 0.5 + 0.5 * Math.sin(x * 0.7) * Math.sin(z * 0.63) + 0.25 * Math.sin(x * 2.1 + z * 1.7);
      const d = distToPolyline(poly, x, z);
      const c = terrainColor(h, n, THREE.MathUtils.clamp(1 - d / 1.6, 0, 1));
      if (isRichWorld(w)) {
        // Surface-only leaf litter and moss. No concealment or collision is inferred from color.
        const moss = THREE.MathUtils.clamp(.4 + .35*Math.sin(x*.12+z*.08) + .2*Math.sin(z*.39-x*.27),0,1);
        const litter = new THREE.Color(0x746047).lerp(new THREE.Color(0x4a6235),moss);
        litter.multiplyScalar(.83 + .15*n);
        c.copy(litter);
      }
      colors.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
    m.receiveShadow = true;
    this.scene.add(m);
  }

  private buildForest(): void {
    const w = this.tl.world;
    const trees = w.trees;
    const rng = new Rng(w.seed + 77);
    const trunkGeo = new THREE.CylinderGeometry(isRichWorld(w) || isThreeWorld(w) ? 1 : 0.72, 1, 1, isThreeWorld(w) ? 64 : isRichWorld(w) ? 24 : 7).translate(0, 0.5, 0);
    this.trunkFade=new Float32Array(trees.length).fill(1);
    this.trunkFadeAttr=new THREE.InstancedBufferAttribute(this.trunkFade,1);
    trunkGeo.setAttribute("aFade",this.trunkFadeAttr);
    const trunkMat=new THREE.MeshStandardMaterial({color:0x5a4330,roughness:1,alphaHash:true});
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
    const leafGeo = new THREE.IcosahedronGeometry(1, isRichWorld(w) || isThreeWorld(w) ? 3 : 1);
    this.fade = new Float32Array(trees.length * 3).fill(1);
    this.fadeAttr = new THREE.InstancedBufferAttribute(this.fade, 1);
    leafGeo.setAttribute("aFade", this.fadeAttr);
    const leafMat = new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true, alphaHash: true });
    const fadeU = this.fadeUniform;
    // Render-only dithered see-through for canopies between the viewing camera and the action.
    // It never touches the simulation's occlusion geometry; the drone-cam inset disables it.
    leafMat.onBeforeCompile = (sh) => {
      sh.uniforms.uFadeOn = fadeU;
      sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nattribute float aFade; varying float vFade;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvFade = aFade;");
      sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying float vFade; uniform float uFadeOn;").replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.a *= mix(1.0, vFade, uFadeOn);");
    };
    trunkMat.onBeforeCompile=leafMat.onBeforeCompile;
    const leaves = new THREE.InstancedMesh(leafGeo, leafMat, trees.length * 3);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pos = new THREE.Vector3();
    const col = new THREE.Color();
    trees.forEach((t, i) => {
      if(isCoverPrimitive(t)){m.makeScale(0,0,0);trunks.setMatrixAt(i,m);for(let k=0;k<3;k++)leaves.setMatrixAt(i*3+k,m);return;}
      pos.set(t.x, t.groundY - 0.3, t.z);
      s.set(t.trunkR, t.trunkTop + 0.3, t.trunkR);
      m.compose(pos, q.identity(), s);
      trunks.setMatrixAt(i, m);
      const base = col.setHSL(0.27 + t.hue * 0.07, 0.42 + t.hue * 0.15, 0.2 + t.hue * 0.08);
      const lumps: [number, number, number, number][] = isRichWorld(w) || isThreeWorld(w) ? [[0,0,0,1],[0,0,0,0],[0,0,0,0]] : [[0, 0, 0, 0.94], [0.45, 0.25, 0.1, 0.62], [-0.35, -0.1, -0.4, 0.58]];
      lumps.forEach((l, k) => {
        pos.set(t.x + l[0] * t.canopyR, t.canopyY + l[1] * t.canopyR, t.z + l[2] * t.canopyR);
        s.set(t.canopyR * l[3], t.canopyR * l[3] * (isRichWorld(w) || isThreeWorld(w) ? 1 : k === 0 ? 0.88 : 0.8), t.canopyR * l[3]);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.hue * 6.28 + k);
        m.compose(pos, q, s);
        leaves.setMatrixAt(i * 3 + k, m);
        leaves.setColorAt(i * 3 + k, col.copy(base).offsetHSL(0, 0, k * 0.025));
      });
    });
    for (const o of [trunks, leaves]) { o.castShadow = true; o.receiveShadow = true; o.instanceMatrix.needsUpdate = true; }
    this.scene.add(trunks, leaves);

    // rocks + understory (purely visual; not part of the sensor model)
    const rockGeo = new THREE.DodecahedronGeometry(1, 0);
    const visibleRocks = isThreeWorld(w) ? [] : w.rocks;
    const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshStandardMaterial({ color: 0x7c7f78, roughness: 1, flatShading: true }), visibleRocks.length);
    visibleRocks.forEach((r, i) => {
      m.compose(pos.set(r.x, r.y + r.s * 0.2, r.z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), i), s.set(r.s * 1.2, r.s * 0.7, r.s));
      rocks.setMatrixAt(i, m);
    });
    rocks.castShadow = true; rocks.receiveShadow = true;
    this.scene.add(rocks);
    const bushN = isRichWorld(w) || isThreeWorld(w) ? 0 : 700;
    const bushes = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }), bushN);
    const poly = TRAIL;
    for (let i = 0; i < bushN; i++) {
      let x = 0, z = 0;
      for (let tries = 0; tries < 8; tries++) {
        x = rng.range(-w.half, w.half); z = rng.range(-w.half, w.half);
        if (distToPolyline(poly, x, z) > 1.6) break;
      }
      const sc = rng.range(0.4, 1.0);
      m.compose(pos.set(x, w.heightAt(x, z) + sc * 0.25, z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, 6)), s.set(sc * 1.1, sc * 0.65, sc));
      bushes.setMatrixAt(i, m);
      bushes.setColorAt(i, col.setHSL(0.22 + rng.range(0, 0.1), 0.45, 0.18 + rng.range(0, 0.1)));
    }
    bushes.receiveShadow = true;
    this.scene.add(bushes);
  }

  private buildRichCover():void {
    const w=this.tl.world;if(!isRichWorld(w))return;
    const colors={boulder:0x858582,log:0x69503a,bush:0x56723b,"leaf-pile":0x9c642f};
    for(const cover of w.covers){
      const fade={value:1};this.coverFades.push({indices:cover.primitives,uniform:fade});
      const mat=new THREE.MeshStandardMaterial({color:colors[cover.kind],roughness:1,flatShading:true,alphaHash:true});
      mat.onBeforeCompile=sh=>{sh.uniforms.uFadeOn=this.fadeUniform;sh.uniforms.uCoverFade=fade;sh.fragmentShader=sh.fragmentShader.replace("#include <common>","#include <common>\nuniform float uFadeOn; uniform float uCoverFade;").replace("#include <color_fragment>","#include <color_fragment>\ndiffuseColor.a *= mix(1.0,uCoverFade,uFadeOn);");};
      for(const id of cover.primitives){const p=w.trees[id];const mesh=new THREE.Mesh(new THREE.IcosahedronGeometry(p.canopyR,3),mat);mesh.position.set(p.x,p.canopyY,p.z);mesh.castShadow=mesh.receiveShadow=true;this.scene.add(mesh);}
    }
    for(const pond of w.ponds){
      const mesh=new THREE.Mesh(new THREE.CircleGeometry(pond.radius,80),new THREE.MeshStandardMaterial({color:0x356b7b,roughness:.22,metalness:.25,transparent:true,opacity:.94,side:THREE.DoubleSide}));
      mesh.rotation.x=-Math.PI/2;mesh.position.set(pond.x,pond.level+.035,pond.z);this.scene.add(mesh);
      const bank=new THREE.Mesh(new THREE.RingGeometry(pond.radius,pond.radius+.65,80),new THREE.MeshStandardMaterial({color:0x8e9970,roughness:1,side:THREE.DoubleSide}));bank.rotation.x=-Math.PI/2;bank.position.copy(mesh.position);this.scene.add(bank);
    }
  }

  private buildSubject(): void {
    const jacket = new THREE.MeshStandardMaterial({ color: 0xf26a21, roughness: 0.7 });
    const pants = new THREE.MeshStandardMaterial({ color: 0x2a3140, roughness: 0.9 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9a77f, roughness: 0.8 });
    // Upper body hangs off a hip pivot so it can lean (sprint, turns) and drop (crouch).
    const HIP = 0.85;
    this.torso.position.y = HIP;
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.5, 4, 10), jacket);
    body.position.y = 1.2 - HIP;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 12), skin);
    head.position.y = 1.72 - HIP;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x1b4f72 }));
    cap.position.y = 1.76 - HIP;
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.5, 0.2), new THREE.MeshStandardMaterial({ color: 0x2e7d5b, roughness: 0.9 }));
    pack.position.set(0, 1.25 - HIP, -0.25);
    this.torso.add(body, head, cap, pack);
    this.subjectRig.add(this.torso);
    for (const sx of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(sx * 0.11, HIP, 0);
      const l = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.62, 3, 8), pants);
      l.position.y = -0.4;
      leg.add(l);
      const arm = new THREE.Group();
      arm.position.set(sx * 0.3, 1.45 - HIP, 0);
      const a = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.45, 3, 8), jacket);
      a.position.y = -0.28;
      arm.add(a);
      this.torso.add(arm);
      this.subjectRig.add(leg);
      this.legs.push(leg); this.arms.push(arm);
    }
    // Footprint / scuff trail of the last few seconds of the subject's real path (render-only world art; never read by the sim).
    this.trail = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.2, 8).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xe8c48a, transparent: true, opacity: 0.55, depthWrite: false }),
      TRAIL_STEPS,
    );
    this.trail.frustumCulled = false;
    this.trail.layers.set(OVERLAY);
    this.scene.add(this.trail);
    this.subjectRig.traverse((o) => { o.castShadow = true; });
  }

  private buildDrone(): void {
    const dark = new THREE.MeshStandardMaterial({ color: 0x20252d, roughness: 0.4, metalness: 0.5 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xe8edf2, roughness: 0.35, metalness: 0.3 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.22, 0.6), accent);
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), dark);
    top.position.y = 0.11;
    this.droneRig.add(body, top);
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, 0.07), dark);
      arm.position.set(sx * 0.4, 0.04, sz * 0.4);
      arm.rotation.y = sx * sz * Math.PI * 0.25;
      const rotor = new THREE.Group();
      rotor.position.set(sx * 0.8, 0.12, sz * 0.8);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.012, 0.06), new THREE.MeshStandardMaterial({ color: 0x111111 }));
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.46, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xaad4ff, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }));
      rotor.add(blade, disc);
      this.droneRig.add(arm, rotor);
      this.rotors.push(blade);
    }
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), new THREE.MeshBasicMaterial({ color: 0x39e08f }));
    led.position.set(0, 0.05, 0.32);
    led.name = "led";
    this.droneRig.add(led);
    this.droneRig.add(this.gimbal);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), dark);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.12, 12).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x4aa3ff, emissive: 0x123a66 }));
    lens.position.z = 0.15;
    ball.add(lens);
    this.gimbal.add(ball);
    this.droneRig.traverse((o) => { o.layers.set(OVERLAY); o.castShadow = true; });
    this.droneRig.scale.setScalar(1.6); // oversized for legibility from the chase views

    // frustum (visual of the exact sensor cone used by the simulation, truncated for clarity)
    const D = 24;
    const hx = Math.tan(CAMERA.hHalf) * D, hy = Math.tan(CAMERA.vHalf) * D;
    const c = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([x, y]) => new THREE.Vector3(x, y, D));
    const o = new THREE.Vector3();
    const lp: THREE.Vector3[] = [];
    c.forEach((v, i) => { lp.push(o, v, v, c[(i + 1) % 4]); });
    this.frustumLines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(lp), new THREE.LineBasicMaterial({ color: 0x39e08f, transparent: true, opacity: 0.8 }));
    const fp: THREE.Vector3[] = [];
    c.forEach((v, i) => fp.push(o, v, c[(i + 1) % 4]));
    this.frustumFill = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints(fp), new THREE.MeshBasicMaterial({ color: 0x39e08f, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide }));
    this.frustum.add(this.frustumLines, this.frustumFill);
    this.frustum.traverse((n) => n.layers.set(OVERLAY));
    this.scene.add(this.frustum);
  }

  private buildTruthMarker(): void {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.06, 8, 36).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    ring.position.y = 0.25;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 9, 6, 1, true), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
    beam.position.y = 4.5;
    const cv = document.createElement("canvas");
    cv.width = 512; cv.height = 96;
    const cx = cv.getContext("2d")!;
    cx.fillStyle = "rgba(10,14,20,0.85)"; cx.fillRect(0, 0, 512, 96);
    cx.strokeStyle = "#fff"; cx.lineWidth = 3; cx.strokeRect(2, 2, 508, 92);
    cx.fillStyle = "#fff"; cx.font = "bold 34px sans-serif"; cx.textAlign = "center";
    cx.fillText("EVALUATION ONLY", 256, 42);
    cx.font = "26px sans-serif"; cx.fillText("ground truth — not a tracker input", 256, 76);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true }));
    label.scale.set(6.4, 1.2, 1);
    label.position.y = 10;
    this.truthGroup.add(ring, beam, label);
    this.truthGroup.traverse((n) => n.layers.set(OVERLAY));
    this.truthGroup.visible = false;
  }

  // ---------------------------------------------------------------- per-frame
  resize(): void {
    const w = this.container.clientWidth || window.innerWidth, h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    const pane=document.getElementById("spectator-pane")?.getBoundingClientRect();
    this.camera.aspect = pane ? pane.width/pane.height : w / h;
    this.camera.updateProjectionMatrix();
  }

  setMode(m: CameraMode): void {
    this.mode = m;
    this.controls.enabled = m === "orbit";
    const pane=document.getElementById("spectator-pane");if(pane)pane.style.touchAction=m==="orbit"?"none":"pan-y";
    if (m === "orbit") {
      const s = sampleAt(this.tl.frames, Math.max(this.lastT, 0)).a.subject;
      this.controls.target.set(s.x, s.y + 3, s.z);
      this.controls.update();
    }
  }

  update(t: number, dtReal: number): Sample {
    const smp = sampleAt(this.tl.frames, t);
    const { a, b, u } = smp;
    const w = this.tl.world;
    const snap = this.lastT < 0 || Math.abs(t - this.lastT) > 0.5 || dtReal <= 0;
    this.lastT = t;

    // subject (the simulated world's evasive agent; its position is not what the tracker estimates).
    // Everything below is driven by the recorded frames: gait phase, speed, turn rate, crouch.
    const sx = lerp(a.subject.x, b.subject.x, u), sz = lerp(a.subject.z, b.subject.z, u);
    const sy = w.heightAt(sx, sz);
    const sSpeed = lerp(a.subject.speed, b.subject.speed, u);
    const crouch = lerp(a.subject.crouch, b.subject.crouch, u);
    const gait = lerp(a.subject.gait, b.subject.gait, u);
    const turn = lerp(a.subject.turnRate, b.subject.turnRate, u);
    const run = THREE.MathUtils.clamp((sSpeed - 2.2) / 3.6, 0, 1);
    const moving = Math.min(1, sSpeed / 1.0);
    const ph = gait * (2.7 + 0.9 * run);
    const swing = Math.sin(ph) * (0.5 + 0.6 * run) * moving;
    const bodyA = a.subject as typeof a.subject & {bodyVersion?:string;body?:BodyInput};
    const bodyB = b.subject as typeof b.subject & {bodyVersion?:string;body?:BodyInput};
    if (bodyA.bodyVersion === BODY_VERSION && bodyA.body && bodyB.body) {
      if (!this.articulatedBody) {this.articulatedBody=new ThreeBodyRig(w);this.scene.add(this.articulatedBody.root);}
      this.subjectRig.visible=false;this.articulatedBody.root.visible=true;
      const sameTransition=bodyA.body.posture.from===bodyB.body.posture.from&&bodyA.body.posture.to===bodyB.body.posture.to;
      this.articulatedBody.update({root:{x:sx,y:sy,z:sz},heading:lerpAngle(bodyA.body.heading,bodyB.body.heading,u),gait:lerp(bodyA.body.gait,bodyB.body.gait,u),speed:lerp(bodyA.body.speed,bodyB.body.speed,u),posture:{from:bodyA.body.posture.from,to:bodyA.body.posture.to,progress:sameTransition?lerp(bodyA.body.posture.progress,bodyB.body.posture.progress,u):bodyA.body.posture.progress}});
    } else {
    this.subjectRig.visible=true;if(this.articulatedBody)this.articulatedBody.root.visible=false;
    this.subjectRig.position.set(sx, sy + Math.abs(Math.sin(ph)) * (0.04 + 0.06 * run) * moving * (1 - crouch), sz);
    this.subjectRig.rotation.y = lerpAngle(a.subject.heading, b.subject.heading, u);
    this.torso.position.y = 0.85 - crouch * 0.4;
    this.torso.rotation.x = run * 0.4 + crouch * 0.75; // lean into the sprint / hunch down
    this.torso.rotation.z = -THREE.MathUtils.clamp(turn * sSpeed * 0.035, -0.4, 0.4); // bank into the turn
    this.legs[0].position.y = this.legs[1].position.y = 0.85 - crouch * 0.4;
    this.legs[0].rotation.x = swing - crouch * 0.9; this.legs[1].rotation.x = -swing - crouch * 0.9;
    this.arms[0].rotation.x = -swing * 0.9 - crouch * 0.5; this.arms[1].rotation.x = swing * 0.9 - crouch * 0.5;
    }
    this.updateTrail(a.i, u);
    this.truthGroup.position.set(sx, sy, sz);
    this.truthGroup.visible = this.showTruth;

    // drone
    const dx = lerp(a.drone.x, b.drone.x, u), dy = lerp(a.drone.y, b.drone.y, u), dz = lerp(a.drone.z, b.drone.z, u);
    const vx = lerp(a.drone.vx, b.drone.vx, u), vz = lerp(a.drone.vz, b.drone.vz, u);
    this.droneRig.position.set(dx, dy, dz);
    this.droneRig.rotation.set(vz * 0.03, lerpAngle(a.drone.yaw, b.drone.yaw, u), -vx * 0.03, "YXZ");
    this.rotors.forEach((r, i) => { r.rotation.y = t * 70 * (i % 2 ? 1 : -1); });
    const cyaw = lerpAngle(a.cam.yaw, b.cam.yaw, u), cpitch = lerp(a.cam.pitch, b.cam.pitch, u);
    const fwd = forward(cyaw, cpitch);
    const camPos = new THREE.Vector3(dx, dy, dz);
    const camTarget = camPos.clone().add(new THREE.Vector3(fwd.x, fwd.y, fwd.z));
    this.frustum.position.copy(camPos);
    this.frustum.lookAt(camTarget);
    this.gimbal.position.set(0, -0.16, 0.1);
    this.gimbal.parent!.updateMatrixWorld();
    this.gimbal.lookAt(camTarget);
    this.insetCam.position.copy(camPos);
    this.insetCam.lookAt(camTarget);
    this.frustum.visible = this.showFrustum;
    const status = a.track.status;
    const stc = STATUS_COLOR[status];
    (this.frustumLines.material as THREE.LineBasicMaterial).color.setHex(a.visibility === "VISIBLE" ? 0x39e08f : stc);
    (this.frustumFill.material as THREE.MeshBasicMaterial).color.setHex(a.visibility === "VISIBLE" ? 0x39e08f : stc);
    ((this.droneRig.getObjectByName("led") as THREE.Mesh).material as THREE.MeshBasicMaterial).color.setHex(stc);

    // belief + corridor
    const tr = { ...a.track };
    tr.x = lerp(a.track.x, b.track.x, u); tr.z = lerp(a.track.z, b.track.z, u);
    tr.vx = lerp(a.track.vx, b.track.vx, u); tr.vz = lerp(a.track.vz, b.track.vz, u);
    tr.radius = lerp(a.track.radius, b.track.radius, u); tr.sigma = lerp(a.track.sigma, b.track.sigma, u);
    const show = a.track.initialised && this.showPrediction;
    this.beliefDraped.disc.visible = this.beliefDraped.ring.visible = show;
    this.beliefBeam.visible = this.beliefMarker.visible = show;
    this.corridor.visible = this.centerLine.visible = show;
    if (a.track.initialised) {
      const r = Math.min(tr.radius, 45);
      this.beliefDraped.setColor(stc);
      this.beliefDraped.set(tr.x, tr.z, Math.max(r, 0.6));
      const by = w.heightAt(tr.x, tr.z);
      this.beliefBeam.position.set(tr.x, by + 3, tr.z);
      (this.beliefBeam.material as THREE.MeshBasicMaterial).color.setHex(stc);
      this.beliefMarker.position.set(tr.x, by + 7 + Math.sin(t * 3) * 0.2, tr.z);
      this.beliefMarker.rotation.y = t * 2;
      (this.beliefMarker.material as THREE.MeshBasicMaterial).color.setHex(stc);
      this.updateCorridor(tr, stc, status !== "TRACKING");
    }
    // observation history
    let lo = 0, hi = this.obsSegEnd.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.obsSegEnd[mid] <= a.i) lo = mid + 1; else hi = mid; }
    this.obsTrail.geometry.setDrawRange(0, lo * 2);
    this.obsTrail.visible=this.showObservationHistory;

    // search viewpoint + gimbal aim line
    const vp = a.viewpoint;
    this.viewpointMarker.visible = this.viewpointLine.visible = !!vp && this.showSearchMarkers;
    if (vp) {
      const vy = w.heightAt(vp.x, vp.z) + 3.0;
      this.viewpointMarker.position.set(vp.x, vy, vp.z);
      this.viewpointMarker.rotation.x = Math.PI / 2;
      const pa = this.viewpointLine.geometry.attributes.position as THREE.BufferAttribute;
      pa.setXYZ(0, dx, dy, dz); pa.setXYZ(1, vp.x, vy, vp.z); pa.needsUpdate = true;
      this.viewpointLine.computeLineDistances();
    }
    this.aimLine.visible = show;
    if (show) {
      const pa = this.aimLine.geometry.attributes.position as THREE.BufferAttribute;
      pa.setXYZ(0, dx, dy, dz); pa.setXYZ(1, tr.x, w.heightAt(tr.x, tr.z) + 1.3, tr.z); pa.needsUpdate = true;
    }

    // light follows the action so shadow resolution stays high
    const fx = (sx + dx) / 2, fz = (sz + dz) / 2;
    this.sun.target.position.set(fx, 0, fz);
    this.sun.position.set(fx - 60, 70, fz - 45);

    const view=this.spectatorTimeline?sampleAt(this.spectatorTimeline.frames,t):smp;
    const vd={x:lerp(view.a.drone.x,view.b.drone.x,view.u),y:lerp(view.a.drone.y,view.b.drone.y,view.u),z:lerp(view.a.drone.z,view.b.drone.z,view.u)};
    this.updateCamera(view, { sx, sy, sz, dx:vd.x, dy:vd.y, dz:vd.z, cyaw:lerpAngle(view.a.cam.yaw,view.b.cam.yaw,view.u), cpitch:lerp(view.a.cam.pitch,view.b.cam.pitch,view.u), droneYaw: lerpAngle(view.a.drone.yaw, view.b.drone.yaw, view.u) }, dtReal, snap);
    this.updateFade({ x: sx, y: sy + 1.3, z: sz }, vd, dtReal, snap);
    return smp;
  }

  private updateTrail(i: number, u: number): void {
    const on = this.showTrail && this.showTruth;
    this.trail.visible = on;
    if (!on) return;
    const fr = this.tl.frames, w = this.tl.world;
    const m = new THREE.Matrix4(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    const stride = Math.max(1, Math.round(0.1 / (fr[1].t - fr[0].t)));
    for (let k = 0; k < TRAIL_STEPS; k++) {
      const j = Math.max(0, i - k * stride);
      const f = fr[j].subject;
      const age = (k * stride + u) / (TRAIL_STEPS * stride);
      const s = Math.max(0.001, 1 - age) * (f.speed > 0.3 || k === 0 ? 1 : 0.6);
      pos.set(f.x, w.heightAt(f.x, f.z) + 0.07, f.z);
      m.compose(pos, q, sc.set(s, 1, s));
      this.trail.setMatrixAt(k, m);
    }
    this.trail.instanceMatrix.needsUpdate = true;
  }

  private updateFade(subject: { x: number; y: number; z: number }, drone: { x: number; y: number; z: number }, dt: number, snap: boolean): void {
    const cam = this.camera.position;
    const k = snap ? 1 : 1 - Math.exp(-7 * Math.max(dt, 0));
    let changed = false;this.cutawayCount=0;
    this.tl.world.trees.forEach((t, i) => {
      let target = 1;
      if (this.seeThrough) {
        const c = { x: t.x, y: t.canopyY, z: t.z };
        const r = t.canopyR + 1.2;
        if (segmentHitsSphere(cam, subject, c, r) || segmentHitsSphere(cam, drone, c, r)) target = 0.015;
      }
      const trunkTarget=this.seeThrough&&(foregroundObstacle(t,cam,subject)||foregroundObstacle(t,cam,drone))?.015:1;
      if(trunkTarget<1)this.cutawayCount++;
      this.trunkFade[i] = trunkTarget < this.trunkFade[i] ? trunkTarget : this.trunkFade[i] + (trunkTarget-this.trunkFade[i])*k;
      const cur = this.fade[i * 3];
      if (Math.abs(cur - target) > 0.004) {
        const v = target < cur ? target : cur + (target - cur) * k;
        this.fade[i * 3] = this.fade[i * 3 + 1] = this.fade[i * 3 + 2] = v;
        changed = true;
      }
    });
    if (changed) this.fadeAttr.needsUpdate = true;
    this.trunkFadeAttr.needsUpdate=true;
    if(this.threeForest)this.cutawayCount+=this.threeForest.updateCutaway(cam,subject,drone,this.seeThrough,k);
    for(const cover of this.coverFades){const blocked=this.seeThrough&&cover.indices.some(i=>foregroundObstacle(this.tl.world.trees[i],cam,subject)||foregroundObstacle(this.tl.world.trees[i],cam,drone));cover.uniform.value = blocked ? .015 : cover.uniform.value + (1-cover.uniform.value)*k;}
  }

  private updateCorridor(tr: Sample["a"]["track"], color: number, lost: boolean): void {
    const pts = predictCorridor(tr, CORRIDOR_HORIZON, CORRIDOR_STEPS);
    const w = this.tl.world;
    const c = new THREE.Color(color);
    let dx = tr.vx, dz = tr.vz;
    if (Math.hypot(dx, dz) < 1e-3) { dx = 1; dz = 0; }
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], n = pts[Math.min(i + 1, pts.length - 1)], pr = pts[Math.max(i - 1, 0)];
      let tx = n.x - pr.x, tz = n.z - pr.z;
      const l = Math.hypot(tx, tz);
      if (l < 1e-6) { tx = dx; tz = dz; } else { tx /= l; tz /= l; }
      const r = Math.min(Math.max(p.radius, 0.35), 45);
      const lx = p.x - tz * r, lz = p.z + tx * r, rx = p.x + tz * r, rz = p.z - tx * r;
      this.corridorPos.set([lx, w.heightAt(lx, lz) + 0.28, lz, rx, w.heightAt(rx, rz) + 0.28, rz], i * 6);
      const alpha = (lost ? 0.42 : 0.3) * (1 - i / pts.length) + 0.04;
      this.corridorCol.set([c.r, c.g, c.b, alpha, c.r, c.g, c.b, alpha], i * 8);
      this.centerPos.set([p.x, w.heightAt(p.x, p.z) + 0.35, p.z], i * 3);
    }
    (this.corridor.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.corridor.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (this.centerLine.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  private projectSpectator(p:THREE.Vector3, final=false):void {
    if(!this.threeGeometry) {projectClear(this.tl.world,p,1,1.5);return;}
    const result=this.threeGeometry.projectClear(p,1,1.5);
    if(!result.success){
      this.spectatorClearanceFailures++;
      if(this.lastClearSpectator)p.copy(this.lastClearSpectator);
      else {
        const world=this.tl.world;
        const top=Math.max(world.heightAt(0,0)+40,...world.trees.map(t=>Math.max(t.groundY+t.trunkTop,t.canopyY+t.canopyR)),...(isThreeWorld(world)?world.n3Solids.map(s=>s.bounds.max.y):[]));
        p.set(0,top+5,0);
        if(!this.threeGeometry.projectClear(p,1,1.5).success)throw Error("No valid initial spectator camera position found");
      }
    }
    if(final)this.lastClearSpectator=p.clone();
  }

  private updateCamera(smp: Sample, s: { sx: number; sy: number; sz: number; dx: number; dy: number; dz: number; cyaw: number; cpitch: number; droneYaw: number }, dtReal: number, snap: boolean): void {
    if (this.mode === "orbit") {
      const k = 1 - Math.exp(-3 * Math.max(dtReal, 0));
      const tgt = this.controls.target;
      const nx = lerp(tgt.x, s.sx, k), ny = lerp(tgt.y, s.sy + 3, k), nz = lerp(tgt.z, s.sz, k);
      this.camera.position.add(new THREE.Vector3(nx - tgt.x, ny - tgt.y, nz - tgt.z));
      tgt.set(nx, ny, nz);
      this.controls.update();
      if(this.threeGeometry){this.projectSpectator(this.camera.position,true);this.camera.lookAt(tgt);}
      return;
    }
    const want = new THREE.Vector3(), look = new THREE.Vector3();
    const t = smp.t;
    const agl = smp.a.drone.agl;
    if (this.mode === "chase") {
      const f = forward(s.cyaw, 0);
      want.set(s.dx - f.x * 9, s.dy + 3.2, s.dz - f.z * 9);
      const g = forward(s.cyaw, s.cpitch);
      look.set(s.dx + g.x * 14, s.dy + g.y * 14, s.dz + g.z * 14);
    } else if (this.mode === "ground") {
      const hd = smp.a.subject.heading;
      want.set(s.sx - Math.sin(hd) * 15 + Math.cos(hd) * 4, s.sy + 2.2, s.sz - Math.cos(hd) * 15 - Math.sin(hd) * 4);
      if (this.groundLookAtSubject) look.set(s.sx, s.sy + 1.3, s.sz);
      else look.set(lerp(s.sx, s.dx, 0.25), lerp(s.sy + 1.3, s.dy, 0.25), lerp(s.sz, s.dz, 0.25));
    } else {
      const fx = lerp(s.sx, s.dx, 0.5), fy = lerp(s.sy + 2, s.dy, 0.5), fz = lerp(s.sz, s.dz, 0.5);
      const dist = Math.hypot(s.dx - s.sx, s.dy - s.sy, s.dz - s.sz);
      const R = THREE.MathUtils.clamp(dist * 1.0 + 12, 24, 50);
      const az = 2.5 + 0.06 * t + 0.5 * Math.sin(t * 0.13);
      const el = THREE.MathUtils.degToRad(17 + 17 * Math.min(agl / 24, 1));
      want.set(fx + Math.sin(az) * Math.cos(el) * R, fy + Math.sin(el) * R, fz + Math.cos(az) * Math.cos(el) * R);
      look.set(fx, fy, fz);
    }
    this.projectSpectator(want);
    if (snap) { this.camPos.copy(want); this.camLook.copy(look); }
    else {
      const k = 1 - Math.exp(-2.6 * dtReal);
      this.camPos.lerp(want, k); this.camLook.lerp(look, 1 - Math.exp(-4 * dtReal));
    }
    this.camera.position.copy(this.camPos);
    let finalLook = this.camLook;
    if (this.mode === "cinematic") {
      // Render-only spectator close-up during sprint/jink/cover/hide beats: a pure function of t (see closeShotRig),
      // blended over the (smoothed) wide shot by the smooth focus weight, so scrubbing and playback agree.
      const foc = closeShotFocus(this.spectatorTimeline?.frames ?? this.tl.frames, t);
      if (foc.w > 0.001) {
        const cs = closeShotRig(this.tl.world, this.spectatorTimeline?.frames ?? this.tl.frames, t);
        const cp = new THREE.Vector3(cs.pos.x, cs.pos.y, cs.pos.z);
        this.projectSpectator(cp);
        this.camera.position.lerp(cp, foc.w);
        finalLook = this.camLook.clone().lerp(new THREE.Vector3(cs.look.x, cs.look.y, cs.look.z), foc.w);
      }
    }
    if(this.threeGeometry){this.projectSpectator(this.camera.position,true);this.camPos.copy(this.camera.position);}
    this.camera.lookAt(finalLook);
  }

  /** Project world points through the drone-camera for the inset overlay. Returns NDC-ish [0..1] or null. */
  insetProject(x: number, y: number, z: number): { u: number; v: number } | null {
    this.insetCam.updateMatrixWorld();
    const v = new THREE.Vector3(x, y, z).project(this.insetCam);
    if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
    return { u: (v.x + 1) / 2, v: (1 - v.y) / 2 };
  }

  /** Evaluation rig only; actual second sensor projection is supplied separately. */
  updateSecondaryDrone(pos: {x:number;y:number;z:number}, yaw:number, t:number, camera?:{yaw:number;pitch:number}):void {
    if(!this.secondaryDrone) {
      this.secondaryDrone=this.droneRig.clone(true);
      this.secondaryRotors=this.rotors.map(r=>this.secondaryDrone!.children[this.droneRig.children.indexOf(r.parent!)].children[r.parent!.children.indexOf(r)]);
      this.secondaryDrone.traverse(o=>{o.layers.set(OVERLAY);});
      const led=this.secondaryDrone.getObjectByName("led") as THREE.Mesh;
      led.material=new THREE.MeshBasicMaterial({color:0x82baff});
      this.scene.add(this.secondaryDrone);
    }
    this.secondaryDrone.position.set(pos.x,pos.y,pos.z);
    this.secondaryDrone.rotation.set(0,yaw,0);
    this.secondaryRotors.forEach((r,i)=>{r.rotation.y=t*70*(i%2?1:-1);});
    if(camera){const f=forward(camera.yaw,camera.pitch);this.secondaryDrone.updateMatrixWorld();this.secondaryDrone.children.at(-1)!.lookAt(new THREE.Vector3(pos.x+f.x,pos.y+f.y,pos.z+f.z));}
    // Rig is an oversized spectator aid, excluded from both sensor layers.
  }

  /** Evaluation rig only; actual third sensor projection is supplied separately. */
  updateThirdDrone(pos: {x:number;y:number;z:number}, yaw:number, t:number, camera?:{yaw:number;pitch:number}):void {
    if(!this.thirdDrone) {
      this.thirdDrone=this.droneRig.clone(true);
      this.thirdRotors=this.rotors.map(r=>this.thirdDrone!.children[this.droneRig.children.indexOf(r.parent!)].children[r.parent!.children.indexOf(r)]);
      this.thirdDrone.traverse(o=>{o.layers.set(OVERLAY);});
      const led=this.thirdDrone.getObjectByName("led") as THREE.Mesh;
      led.material=new THREE.MeshBasicMaterial({color:0xc59aff});
      this.scene.add(this.thirdDrone);
    }
    this.thirdDrone.position.set(pos.x,pos.y,pos.z);
    this.thirdDrone.rotation.set(0,yaw,0);
    this.thirdRotors.forEach((r,i)=>{r.rotation.y=t*70*(i%2?1:-1);});
    if(camera){const f=forward(camera.yaw,camera.pitch);this.thirdDrone.updateMatrixWorld();this.thirdDrone.children.at(-1)!.lookAt(new THREE.Vector3(pos.x+f.x,pos.y+f.y,pos.z+f.z));}
    // Rig is an oversized spectator aid, excluded from all sensor layers.
  }

  render(inset: DOMRect | null, additional: readonly {rect:DOMRect;camera:THREE.PerspectiveCamera}[]=[], contentClip:DOMRect|null=null): void {
    const r = this.renderer;
    const size = r.getSize(new THREE.Vector2());
    // Optional team scrollport clip affects pixels only, never viewport projection or camera intrinsics.
    const clip=(rect:DOMRect)=>{
      if(!contentClip)return;
      const cr=r.domElement.getBoundingClientRect();
      const left=Math.max(rect.left,contentClip.left,cr.left),right=Math.min(rect.right,contentClip.right,cr.right);
      const top=Math.max(rect.top,contentClip.top,cr.top),bottom=Math.min(rect.bottom,contentClip.bottom,cr.bottom);
      r.setScissor(left-cr.left,size.y-(bottom-cr.top),Math.max(0,right-left),Math.max(0,bottom-top));
    };
    r.setScissorTest(false);
    r.setViewport(0, 0, size.x, size.y);r.clear();
    const pane=document.getElementById("spectator-pane")?.getBoundingClientRect();
    if(pane){r.setScissorTest(true);r.setViewport(pane.left,size.y-pane.bottom,pane.width,pane.height);r.setScissor(pane.left,size.y-pane.bottom,pane.width,pane.height);this.camera.aspect=pane.width/pane.height;this.camera.updateProjectionMatrix();}
    if(pane)clip(pane);
    this.fadeUniform.value = this.seeThrough ? 1 : 0;
    r.render(this.scene, this.camera);
    if (inset) {
      const cr = r.domElement.getBoundingClientRect();
      const x = inset.left - cr.left, y = size.y - (inset.bottom - cr.top);
      r.setScissorTest(true);
      r.setViewport(x, y, inset.width, inset.height);
      r.setScissor(x, y, inset.width, inset.height);
      clip(inset);
      r.clearDepth();
      this.fadeUniform.value = 0;
      r.render(this.scene, this.insetCam);
      this.fadeUniform.value = this.seeThrough ? 1 : 0;
      r.setScissorTest(false);
    }
    for(const {rect,camera} of additional) {
      const cr=r.domElement.getBoundingClientRect();
      const x=rect.left-cr.left,y=size.y-(rect.bottom-cr.top);
      r.setScissorTest(true);r.setViewport(x,y,rect.width,rect.height);r.setScissor(x,y,rect.width,rect.height);
      clip(rect);
      r.clearDepth();this.fadeUniform.value=0;
      r.render(this.scene,camera);
      this.fadeUniform.value=this.seeThrough?1:0;r.setScissorTest(false);
    }
  }
}
