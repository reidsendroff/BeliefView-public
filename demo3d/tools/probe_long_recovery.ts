/** Development repair screen. Never consumes reserved worlds. */
import {readFileSync,writeFileSync,mkdirSync,readdirSync,copyFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {dirname} from 'node:path';
import {simulateTeam} from '../src/team/runtime';
import {generateTeamScenario} from '../src/team/scenario';
const out='output/team-long-recovery-v2-targeted';if(existsSync(out))throw Error('Preserve existing probe');mkdirSync(out,{recursive:true});
const files=readdirSync('src/team').filter(f=>f.endsWith('.ts')&&!['app.ts','simulatedGps.ts','replay.ts','worker.ts'].includes(f)).map(f=>'src/team/'+f);
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');const hashes=Object.fromEntries(files.map(p=>[p,hash(p)]));for(const p of files){const dest=out+'/source/'+p;mkdirSync(dirname(dest),{recursive:true});copyFileSync(p,dest);}writeFileSync(out+'/source-hashes.json',JSON.stringify(hashes,null,2));
const results=[];
for(const[index,family,arm]of [[9,'original','shared'],[9,'original','coordinated'],[13,'original','coordinated'],[13,'rich','independent'],[17,'original','coordinated'],[16,'rich','shared']] as const){
 const timeline=simulateTeam(generateTeamScenario(220000+index,225000+index,family),arm,{duration:300,assist:true,extendedRecovery:true});
 const trace=out+`/${family}-${index}-${arm}.json.gz`;writeFileSync(trace,gzipSync(JSON.stringify(timeline)));const d=timeline.diagnostics;
 const result={index,family,arm,metrics:timeline.metrics,diagnostics:d,trace,pass:d.dronePhysicalInvalidFrames===0&&d.dronePhysicalInvalidSegments===0&&d.normalMarginDeficitIntroductions===0&&(d.recovery as any).blockedEvents===0&&Math.max(...Object.values(d.maxConsecutiveHoldSById as Record<string,number>))<=3};results.push(result);writeFileSync(out+'/results.json',JSON.stringify({complete:false,hashes,results},null,2));console.log(JSON.stringify(result));
}
for(const[p,h]of Object.entries(hashes))if(hash(p)!==h)throw Error('Source changed '+p);writeFileSync(out+'/results.json',JSON.stringify({complete:true,hashes,results},null,2));
