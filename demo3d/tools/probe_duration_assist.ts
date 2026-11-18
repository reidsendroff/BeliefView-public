/** Development-only before matrix freeze. No reserved worlds. */
import { readFileSync,writeFileSync,mkdirSync } from "node:fs";
import { gunzipSync,gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { simulateTeam } from "../src/team/runtime";
import { generateTeamScenario } from "../src/team/scenario";
import type {TeamArm} from "../src/team/types";
const out="output/team-duration-assist-probe";mkdirSync(out,{recursive:true});
const old=JSON.parse(readFileSync("ml/results/team_recovery_v5_engineering.json","utf8"));
const digest=(x:unknown)=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const checks:any[]=[];
for(const arm of ["independent","sector","shared","coordinated"] as TeamArm[]){
 const scenario=generateTeamScenario(220016,225016,"rich");
 const tl=simulateTeam(scenario,arm,{duration:75,assist:false});
 const row=old.rows.find((r:any)=>r.worldSeed===220016&&r.family==="rich");
 const prior=JSON.parse(gunzipSync(readFileSync(row.arms[arm].tracePath)).toString());
 const a={frames:tl.frames,decisions:tl.decisions,beliefEpochs:tl.beliefEpochs,metrics:tl.metrics};
 const b={frames:prior.frames,decisions:prior.decisions,beliefEpochs:prior.beliefEpochs,metrics:prior.metrics};
 const ok=digest(a)===digest(b);checks.push({check:"assist-disabled75 baseline exact",arm,ok,digest:digest(a)});console.log(JSON.stringify(checks.at(-1)));
}
for(const [index,family,arm] of [[16,"rich","shared"],[9,"rich","shared"],[31,"original","coordinated"]] as const){
 const tl=simulateTeam(generateTeamScenario(220000+index,225000+index,family),arm,{duration:300,assist:true});
 const path=`${out}/${family}-${index}-${arm}-300.json.gz`;writeFileSync(path,gzipSync(JSON.stringify(tl)));
 const first=tl.frames.find(f=>f.assist?.some(a=>a.state==="investigating"));
 const result={check:"300s assist probe",index,family,arm,firstAssist:first?{t:first.t,status:first.assist,command:first.commandedMotion}:null,metrics:tl.metrics,diagnostics:tl.diagnostics,bytes:Buffer.byteLength(JSON.stringify(tl)),trace:path};checks.push(result);console.log(JSON.stringify(result));
 writeFileSync(`${out}/probe.json`,JSON.stringify(checks,null,2));
}
writeFileSync(`${out}/probe.json`,JSON.stringify(checks,null,2));
