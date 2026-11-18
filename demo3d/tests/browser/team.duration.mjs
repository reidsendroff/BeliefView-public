/** Late-horizon sensor isolation and duration controls on the actual local production build. */
import {chromium} from 'playwright-core';
import {preview} from 'vite';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url)),out=root+'output/playwright/team-duration';mkdirSync(out,{recursive:true});
const server=await preview({root,preview:{port:4187,strictPort:true,host:'127.0.0.1'}}),base='http://127.0.0.1:4187/';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:false});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),checks=[],errors=[],requests=[],pixels=[],timings=[];
page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>requests.push(r.url()));
const check=(ok,name,detail)=>{checks.push({ok:!!ok,name,detail});console.log(`${ok?'PASS':'FAIL'} ${name}`);};
const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const sha=b=>createHash('sha256').update(b).digest('hex');
const ready=async()=>{await page.waitForFunction(()=>window.__team?.firstFrameMs>0,null,{timeout:180000});await settle();};
const state=()=>page.evaluate(()=>({duration:window.__team.duration,time:window.__team.time,playing:window.__team.playing,digest:window.__team.timelineDigest,computeMs:window.__team.computeMs,firstFrameMs:window.__team.firstFrameMs,bytes:window.__team.serializedBytes,frames:window.__team.timeline.frames.length,cam:window.__team.mode}));
try{
 await page.goto(base+'?mission=team&missionIndex=16&teamarm=shared&terrain=rich&paused=1&t=0&cam=cinematic');await ready();
 const defaultStartup=await state();timings.push(defaultStartup);check(defaultStartup.duration===180&&defaultStartup.frames===3601,'durationlessdefaultisactual180seconds',defaultStartup);
 check(defaultStartup.computeMs<=15000&&defaultStartup.bytes<=100000000,'default180cleanlocalbudget',defaultStartup);
 await page.goto(base+'?mission=team&duration=300&missionIndex=16&teamarm=shared&terrain=rich&paused=1&t=150&cam=ground');await ready();
 const initial=await state();timings.push(initial);check(initial.duration===300&&initial.frames===6001&&initial.time===150,'actual300s timeline andlateURLseek',initial);
 const gps=await page.evaluate(()=>{
  const f=window.__team.timeline.frames[Math.floor(window.__team.time/.05)],R=6378137;
  const text=p=>`${(45+p.z/R*180/Math.PI).toFixed(6)}, ${(-93+p.x/(R*Math.cos(Math.PI/4))*180/Math.PI).toFixed(6)}`;
  return f.aircraft.map(a=>({id:a.id,expected:text(a.state.pos),actual:document.getElementById('gps-'+a.id).textContent}));
 });check(gps.every(g=>g.actual.includes(g.expected)&&g.actual.includes('recorded pose')), 'both simulatedGPS coordinates derivefromrecordedposes',gps);
 check(initial.computeMs<=30000&&initial.bytes<=100000000,'300s localcompute/payloadbudget',initial);
 for(const t of [150,290]){
  await page.locator('#team-scrub').fill(String(t));await page.locator('#team-scrub').dispatchEvent('input');
  await page.evaluate(()=>{document.getElementById('team-content').scrollTo(0,0);for(const[id,on]of[['team-cutaway',true],['team-truth',false]]){const c=document.getElementById(id);if(c.checked!==on)c.click();}});await settle();await page.waitForTimeout(200);
  const on=[];for(const id of ['A','B']){const b=await page.locator('#sensor-'+id).screenshot();on.push(b);writeFileSync(`${out}/sensor-${id}-${t}-on.png`,b);}
  await page.evaluate(()=>{document.getElementById('team-cutaway').click();document.getElementById('team-truth').click();});await settle();await page.waitForTimeout(200);
  for(const[i,id]of ['A','B'].entries()){const off=await page.locator('#sensor-'+id).screenshot();writeFileSync(`${out}/sensor-${id}-${t}-off.png`,off);pixels.push({t,id,on:sha(on[i]),off:sha(off)});check(on[i].equals(off),`sensor${id}opaque/invariant at${t}s`);}
  await page.evaluate(()=>document.querySelectorAll('.team-gps').forEach(e=>e.style.visibility='hidden'));await settle();
  for(const[i,id]of ['A','B'].entries())check(on[i].equals(await page.locator('#sensor-'+id).screenshot()),`sensor${id}unchangedbyGPSlabelvisibilityat${t}s`);
  await page.evaluate(()=>document.querySelectorAll('.team-gps').forEach(e=>e.style.visibility=''));await settle();
  check(!on[0].equals(on[1]),`distinct actual A/B images at${t}s`);
 }
 await page.locator('#team-scrub').fill('300');await page.locator('#team-scrub').dispatchEvent('input');await settle();check((await state()).time===300,'300s endpoint renders bothfinalframes');
 await page.locator('#team-restart').click();await page.waitForTimeout(300);check((await state()).time<2&&(await state()).playing,'restart from300 advancesnewplayback');await page.locator('#team-play').click();
 for(const[width,height]of[[1440,1000],[320,568]]){
  await page.setViewportSize({width,height});await settle();
  if(!(await page.locator('#team-duration').isVisible()))await page.locator('#team-config summary').click();
  await page.locator('#team-duration').scrollIntoViewIfNeeded();
  check(await page.locator('#team-duration').evaluate(e=>{const r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e;}),`durationselectreachable${width}x${height}`);
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('.team-gps')].every(e=>{const r=e.getBoundingClientRect(),p=e.previousElementSibling.getBoundingClientRect();return r.top>=p.bottom-1&&r.right<=innerWidth+1;})),`GPSlabelsoutsidecameraandnooverflow${width}x${height}`);
  await page.locator('#sensor-B').scrollIntoViewIfNeeded();await settle();await page.screenshot({path:`${out}/layout-${width}x${height}.png`});
 }
 await Promise.all([page.waitForURL(u=>u.searchParams.get('duration')==='180'),page.locator('#team-duration').selectOption('180')]);await ready();let s=await state();timings.push(s);check(s.duration===180&&s.time===0&&!s.playing&&s.frames===3601,'durationchange recomputes180 andresetspaused');check(s.computeMs<=15000&&s.bytes<=100000000,'180s localcompute/payloadbudget',s);
 await page.locator('#team-scrub').fill('120');await page.locator('#team-scrub').dispatchEvent('input');
 if(!(await page.locator('#team-arm').isVisible()))await page.locator('#team-config summary').click();
 await Promise.all([page.waitForURL(u=>u.searchParams.get('teamarm')==='independent'),page.locator('#team-arm').selectOption('independent')]);await ready();s=await state();check(s.duration===180&&s.time===120,'policychangepreservesdurationandtime');
 await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:base});
 await page.locator('#team-copy').click();const copied=await page.evaluate(()=>navigator.clipboard.readText());
 check(new URL(copied).searchParams.get('duration')==='180'&&new URL(copied).searchParams.get('t')==='120.00','copiedURLpreservesdurationandlateposition');
 const digestBefore=(await state()).digest;await page.reload();await ready();check((await state()).digest===digestBefore&&(await state()).time===120,'reloadedlongURLdeterministic');
 const fault=await browser.newPage();await fault.addInitScript(()=>{const Native=window.Worker;window.Worker=class extends Native{constructor(...args){super(...args);this.addEventListener('message',e=>{if(e.data?.type==='ready')e.data.timeline.frames.pop();});}};});
 await fault.goto(base+'?mission=team&duration=180');await fault.waitForFunction(()=>document.getElementById('load-message')?.textContent.includes('duration mismatch'),null,{timeout:180000});
 check(!(await fault.evaluate(()=>window.__team?.timeline)),'wrongdurationworkertransportblockedbeforerender');await fault.close();
 await page.goto(base+'?mission=team&duration=300&paused=1');await page.locator('#team-cancel').click();await page.waitForTimeout(300);check(!(await page.evaluate(()=>window.__team?.timeline)),'longworker cancellation prevents stale timeline');await page.locator('#team-retry').click();await ready();check((await state()).duration===300&&(await state()).frames===6001,'retry computes requested300seconds');
 const text=await page.evaluate(()=>document.body.innerText+' '+[...document.querySelectorAll('[aria-label],[title],option')].map(e=>[e.getAttribute('aria-label'),e.getAttribute('title'),e.textContent].join(' ')).join(' '));check(!/aircraft/i.test(text),'renderedteamcopyusesdroneincludingaria/options');
 check(errors.length===0,'no runtimeerrors',errors);check(!requests.some(u=>!u.startsWith(base)&&!u.startsWith('blob:')&&!u.startsWith('data:')),'noexternalrequests');check(!requests.some(u=>/\.onnx|ort-wasm|\/models\//.test(u)),'noONNX/modelrequests');
}catch(e){check(false,'suitecomplete',String(e));}finally{writeFileSync(root+'ml/results/team_duration_browser.json',JSON.stringify({checks,errors,requests,pixels,timings},null,2));await browser.close();await server.httpServer.close();}
if(checks.some(c=>!c.ok))process.exitCode=1;
