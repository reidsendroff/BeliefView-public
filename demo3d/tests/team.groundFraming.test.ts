import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Stage } from '../src/render/stage';
import { lerp } from '../src/sim/playback';

const separated = { sx:9.630794418210924, sy:2.3415746875343086, sz:15.552424918796337, dx:-31.343442083183646, dy:3.73037569650019, dz:59.61819086998182, cyaw:0, cpitch:0, droneYaw:0 };
function ground(s:typeof separated, enabled:boolean, trees:unknown[] = []) {
  // Stub world-clearance projection to isolate the Ground target and aim math.
  const stage = { mode:'ground', groundLookAtSubject:enabled, tl:{world:{trees, heightAt:()=>0}}, camPos:new THREE.Vector3(), camLook:new THREE.Vector3(), camera:new THREE.PerspectiveCamera(52,16/9,.3,600), projectSpectator(){} };
  (Stage.prototype as any).updateCamera.call(stage,{t:10,a:{drone:{agl:3},subject:{heading:2.681}}},s,.016,true);
  return stage;
}
describe('team-only Ground framing',()=>{
  it('fixes the separated-drone aim while retaining the exact camera position',()=>{
    const old=ground(separated,false),team=ground(separated,true);
    expect(team.camPos.toArray()).toEqual(old.camPos.toArray());
    expect(team.camLook.toArray()).toEqual([separated.sx,separated.sy+1.3,separated.sz]);
    expect(team.camera.position.distanceTo(team.camLook)).toBeGreaterThan(8);
    team.camera.updateMatrixWorld();const ndc=team.camLook.clone().project(team.camera);
    expect(Math.abs(ndc.x)).toBeLessThan(.25);expect(Math.abs(ndc.y)).toBeLessThan(.25);
  });
  it('preserves legacy target and obstacle-projected position for near and far drones',()=>{
    for(const s of [separated,{...separated,dx:12,dy:5,dz:17}]){
      const obstacle={x:0,z:28,trunkR:2,trunkTop:12,canopyY:15,canopyR:3};
      const old=ground(s,false,[obstacle]),team=ground(s,true,[obstacle]);
      expect(old.camLook.toArray()).toEqual([lerp(s.sx,s.dx,.25),lerp(s.sy+1.3,s.dy,.25),lerp(s.sz,s.dz,.25)]);
      expect(team.camPos.toArray()).toEqual(old.camPos.toArray());
    }
  });
  it('defaults off and is enabled only in the team renderer',()=>{
    expect(readFileSync('src/render/stage.ts','utf8')).toContain('groundLookAtSubject = false');
    for(const f of ['src/main.ts','src/team/worker.ts','src/team/runtime.ts','src/sim/sensor.ts'])expect(readFileSync(f,'utf8')).not.toContain('groundLookAtSubject');
    expect(readFileSync('src/team/app.ts','utf8')).toContain('stage.groundLookAtSubject = true');
  });
});
