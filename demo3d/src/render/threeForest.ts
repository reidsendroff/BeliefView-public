/** Exact convex face mesh for the N3 public geometry. Surface colors add no physical shape. */
import * as THREE from "three";
import {
  segmentHitsConvex,
  type ConvexSolid,
  type ThreeWorld,
} from "../team/threeGeometry";
import type { Vec3 } from "../sim/types";
export function convexMeshGeometry(solid: ConvexSolid): THREE.BufferGeometry {
  const positions: number[] = [],
    colors: number[] = [];
  for (const face of solid.faces)
    for (let j = 1; j < face.length - 1; j++)
      for (const index of [face[0], face[j], face[j + 1]]) {
        const v = solid.vertices[index];
        positions.push(v.x, v.y, v.z);
        const top =
          (v.y - solid.bounds.min.y) /
          Math.max(0.01, solid.bounds.max.y - solid.bounds.min.y);
        const noise =
          0.5 +
          0.5 *
            Math.sin(v.x * 2.7 + v.z * 1.6) *
            Math.cos(v.z * 3.1 - v.y * 1.7);
        const color =
          solid.kind === "log"
            ? new THREE.Color(0x654631).lerp(
                new THREE.Color(0x897151),
                noise * 0.45,
              )
            : new THREE.Color(0x666961)
                .lerp(new THREE.Color(0x8b8c7c), noise * 0.4)
                .lerp(
                  new THREE.Color(0x4c653b),
                  Math.max(0, top - 0.8) * 2.2 * noise,
                );
        colors.push(color.r, color.g, color.b);
      }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}
export class ThreeForestSolids {
  readonly root = new THREE.Group();
  private items: { solid: ConvexSolid; fade: { value: number } }[] = [];
  constructor(world: ThreeWorld, fadeOn: { value: number }) {
    this.root.name = "N3 exact physical cover";
    for (const solid of world.n3Solids) {
      const fade = { value: 1 },
        material = new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.98,
          flatShading: true,
          alphaHash: true,
        });
      material.onBeforeCompile = (sh) => {
        sh.uniforms.uFadeOn = fadeOn;
        sh.uniforms.uCoverFade = fade;
        sh.fragmentShader = sh.fragmentShader
          .replace(
            "#include <common>",
            "#include <common>\nuniform float uFadeOn; uniform float uCoverFade;",
          )
          .replace(
            "#include <color_fragment>",
            "#include <color_fragment>\ndiffuseColor.a *= mix(1.0,uCoverFade,uFadeOn);",
          );
      };
      const mesh = new THREE.Mesh(convexMeshGeometry(solid), material);
      mesh.name = solid.id;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
      this.items.push({ solid, fade });
    }
  }
  updateCutaway(
    camera: Vec3,
    subject: Vec3,
    drone: Vec3,
    enabled: boolean,
    k: number,
  ): number {
    let count = 0;
    for (const item of this.items) {
      const blocked =
        enabled &&
        (segmentHitsConvex(item.solid, camera, subject, 0.65) ||
          segmentHitsConvex(item.solid, camera, drone, 0.65));
      if (blocked) count++;
      item.fade.value = blocked
        ? 0.015
        : item.fade.value + (1 - item.fade.value) * k;
    }
    return count;
  }
}
