import{describe,it,expect}from'vitest';
import * as THREE from 'three';
import{ThreeBodyRig}from'../src/render/threeBodyRig';
import{convexMeshGeometry}from'../src/render/threeForest';
import{makeBoulder,makeLog}from'../src/team/threeWorld';
import{Rng}from'../src/sim/rng';
describe('shared N3 visible physical geometry',()=>{
 it('keeps every visible body vertex inside its exact shared capsule for all four poses',()=>{
  const rig=new ThreeBodyRig({heightAt:()=>0});
  for(const posture of ['standing','crouched','kneeling','prone'] as const){
   const pose=rig.update({root:{x:0,y:0,z:0},heading:.6,gait:0,speed:0,posture:{from:posture,to:posture,progress:1}});
   expect(pose.groundingValid,posture).toBe(true);rig.root.updateMatrixWorld(true);
   for(const child of rig.root.children){const mesh=child as THREE.Mesh;if(!mesh.visible)continue;const capsule=pose.capsules.find(c=>c.id===mesh.name.split('/')[0])!;expect(capsule).toBeDefined();const a=new THREE.Vector3(capsule.a.x,capsule.a.y,capsule.a.z),b=new THREE.Vector3(capsule.b.x,capsule.b.y,capsule.b.z),ab=b.clone().sub(a),length2=ab.lengthSq(),positions=mesh.geometry.attributes.position;
    for(let i=0;i<positions.count;i++){const p=new THREE.Vector3().fromBufferAttribute(positions,i).applyMatrix4(mesh.matrixWorld),u=length2?Math.max(0,Math.min(1,p.clone().sub(a).dot(ab)/length2)):0;expect(p.distanceTo(a.clone().addScaledVector(ab,u))).toBeLessThanOrEqual(capsule.radius+1e-6);}
   }
  }
 });
 it('renders only the vertices shared by the convex face contract',()=>{
  for(const solid of [makeBoulder('test',12,-8,1,2.4,3,new Rng(4)),makeLog('log',2,5,.4,.65,4,.6)]){
   const mesh=convexMeshGeometry(solid),positions=mesh.attributes.position;
   expect(positions.count).toBeGreaterThan(12);
   for(let i=0;i<positions.count;i++){const p=new THREE.Vector3().fromBufferAttribute(positions,i);expect(solid.vertices.some(v=>p.distanceTo(new THREE.Vector3(v.x,v.y,v.z))<1e-5)).toBe(true);}
   mesh.dispose();
  }
 });
});
