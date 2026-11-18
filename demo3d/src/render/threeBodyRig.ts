/** Procedural N3 body. Every visible primitive lies within the shared collision capsules. */
import * as THREE from "three";
import { bodyPose, type BodyInput, type BodyPose } from "../team/threeBody";
import type { World } from "../sim/world";
export class ThreeBodyRig {
  readonly root = new THREE.Group();
  private parts = new Map<string, { shaft: THREE.Mesh; ends: THREE.Mesh[] }>();
  constructor(private ground: Pick<World, "heightAt">) {
    this.root.name = "N3 shared articulated body";
  }
  update(input: BodyInput): BodyPose {
    const pose = bodyPose(input, this.ground);
    for (const capsule of pose.capsules) {
      let part = this.parts.get(capsule.id);
      if (!part) {
        const skin =
          capsule.id === "head" ||
          capsule.id === "neck" ||
          capsule.id.startsWith("hand");
        const pants = /Leg|foot|pelvis/.test(capsule.id);
        const material = new THREE.MeshStandardMaterial({
          color: skin ? 0xd9a77f : pants ? 0x2a3140 : 0xf26a21,
          roughness: 0.85,
        });
        const shaft = new THREE.Mesh(
          new THREE.CylinderGeometry(1, 1, 1, 12),
          material,
        );
        const sphere = new THREE.SphereGeometry(1, 16, 12);
        if (capsule.id === "head") {
          const pos = sphere.attributes.position,
            colors = new Float32Array(pos.count * 3);
          for (let i = 0; i < pos.count; i++) {
            const c = new THREE.Color(pos.getY(i) > 0.35 ? 0x1b4f72 : 0xd9a77f);
            colors.set(c.toArray(), i * 3);
          }
          sphere.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        }
        const ends = [
          new THREE.Mesh(
            sphere,
            capsule.id === "head"
              ? new THREE.MeshStandardMaterial({
                  vertexColors: true,
                  roughness: 0.85,
                })
              : material,
          ),
          new THREE.Mesh(sphere, material),
        ];
        shaft.name = `${capsule.id}/shaft`;
        ends.forEach((mesh,i)=>{mesh.name=`${capsule.id}/end${i}`;});
        part = { shaft, ends };
        this.parts.set(capsule.id, part);
        for (const o of [shaft, ...ends]) {
          o.castShadow = true;
          o.receiveShadow = true;
          this.root.add(o);
        }
      }
      const a = new THREE.Vector3(capsule.a.x, capsule.a.y, capsule.a.z),
        b = new THREE.Vector3(capsule.b.x, capsule.b.y, capsule.b.z),
        delta = b.clone().sub(a),
        length = delta.length();
      part.shaft.visible = length > 1e-8;
      part.shaft.position.copy(a).add(b).multiplyScalar(0.5);
      part.shaft.scale.set(capsule.radius, length, capsule.radius);
      if (length > 1e-8)
        part.shaft.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          delta.normalize(),
        );
      part.ends[0].position.copy(a);
      part.ends[0].scale.setScalar(capsule.radius);
      part.ends[1].position.copy(b);
      part.ends[1].scale.setScalar(capsule.radius);
      part.ends[1].visible = length > 1e-8;
    }
    return pose;
  }
}
