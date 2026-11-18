"""Complete-trace engineering gate. No performance-superiority or final-audit claim."""
import gzip, hashlib, json, math, sys
from pathlib import Path
source=Path(sys.argv[1] if len(sys.argv)>1 else 'ml/results/team_recovery_engineering.json')
data=json.loads(source.read_text())
if not data['complete']:raise SystemExit('Engineering evaluation is not complete')
failures=[];rows=[]
def distance(a,b):return math.sqrt(sum((a[k]-b[k])**2 for k in ('x','y','z')))
def swept(a0,a1,b0,b1):
 r=[a0[k]-b0[k] for k in ('x','y','z')];v=[a1[k]-b1[k]-r[i] for i,k in enumerate(('x','y','z'))];vv=sum(x*x for x in v);u=max(0,min(1,-sum(x*y for x,y in zip(r,v))/vv)) if vv else 0
 return math.sqrt(sum((x+u*y)**2 for x,y in zip(r,v)))
def finite_vector(p):return all(isinstance(p[k],(int,float)) and math.isfinite(p[k]) for k in ('x','y','z'))
for row in data['rows']:
 for arm,run in row['arms'].items():
  identity={'family':row['family'],'worldSeed':row['worldSeed'],'arm':arm};d=run['diagnostics'];bad=[]
  for key in ('dronePhysicalInvalidFrames','dronePhysicalInvalidSegments','waterFrames','subjectPenetrationFrames','normalMarginDeficitIntroductions'):
   if d[key]!=0:bad.append({'check':key,'value':d[key],'required':0})
  for key in ('introducedDeficitViolations','blockedEvents'):
   if d['recovery'][key]!=0:bad.append({'check':'recovery.'+key,'value':d['recovery'][key],'required':0})
  raw=Path(run['tracePath']).read_bytes();assert hashlib.sha256(raw).hexdigest()==run['traceSha256'];tl=json.loads(gzip.decompress(raw));frames=tl['frames'];assert len(frames)==1501
  command_runs={'A':0,'B':0};max_command_runs={'A':0,'B':0};max_runs={'A':0,'B':0};current={'A':0,'B':0};holds={'A':0,'B':0};min_sep=math.inf;max_step=0;missing=0;first=None;nonfinite=0
  for i,f in enumerate(frames):
   aircraft={a['id']:a for a in f['aircraft']}
   nonfinite+=not finite_vector(f['subject'])
   for a in aircraft.values():
    nonfinite+=not finite_vector(a['state']['pos']);nonfinite+=not finite_vector(a['state']['vel'])
    nonfinite+=not all(isinstance(a['state'][k],(int,float)) and math.isfinite(a['state'][k]) for k in ('camYaw','camPitch'))
   if i==1500:continue
   any_observation=any(a['observation'] is not None for a in aircraft.values());missing+=not any_observation
   if any_observation and first is None:first=i*.05
   next_aircraft={a['id']:a for a in frames[i+1]['aircraft']}
   for id in ('A','B'):
    held=id in f['heldIds'];holds[id]+=held;current[id]=current[id]+1 if held else 0;max_runs[id]=max(max_runs[id],current[id])
    step=distance(aircraft[id]['state']['pos'],next_aircraft[id]['state']['pos']);max_step=max(max_step,step)
    command=next((c['displacement']for c in f.get('commandedMotion',[])if c['id']==id),None)
    attempted=command is not None and math.sqrt(sum(v*v for v in command.values()))/.05>.1
    stalled=attempted and step<1e-5
    command_runs[id]=command_runs[id]+1 if stalled else 0;max_command_runs[id]=max(max_command_runs[id],command_runs[id])
    if held and step>1e-7:bad.append({'check':'heldId actually moved','id':id,'t':f['t'],'stepM':step})
   min_sep=min(min_sep,swept(aircraft['A']['state']['pos'],next_aircraft['A']['state']['pos'],aircraft['B']['state']['pos'],next_aircraft['B']['state']['pos']))
  if nonfinite:bad.append({'check':'nonfinite physical state','value':nonfinite})
  if min_sep<4-1e-6:bad.append({'check':'swept pair separation','value':min_sep,'required':4})
  for id in ('A','B'):
   if max_runs[id]*.05>3+1e-8:bad.append({'check':'max consecutive hold','id':id,'value':max_runs[id]*.05,'requiredMaximum':3})
   if max_command_runs[id]*.05>3+1e-8:bad.append({'check':'commanded stationary window','id':id,'value':max_command_runs[id]*.05,'requiredMaximum':3})
   assert abs(holds[id]*.05-d['holdSecondsById'][id])<1e-7
   assert abs(max_runs[id]*.05-d['maxConsecutiveHoldSById'][id])<1e-7
  assert abs(missing*.05-run['metrics']['totalNoFixS'])<1e-7
  assert abs((first if first is not None else 75)-run['metrics']['initialAcquisitionS'])<1e-7
  for epoch in tl['beliefEpochs']:
   for sensor in epoch['sensors']:
    p=sensor['probability'];assert all(math.isfinite(v) and v>=0 for v in p);assert abs(sum(p)-1)<1e-8
  rows.append({**identity,'pass':not bad,'maxCommandedStationaryS':{k:v*.05 for k,v in max_command_runs.items()},'maxConsecutiveHoldS':{k:v*.05 for k,v in max_runs.items()},'minimumSweptSeparationM':min_sep,'maxActualStepM':max_step,'blockedEvents':d['recovery']['blockedEvents'],'normalMarginDeficitIntroductions':d['normalMarginDeficitIntroductions']})
  failures.extend({**identity,**b}for b in bad)
report={'role':'Complete-trace engineering reliability gate, not final performance audit','source':str(source),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'gateSourceSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'allPass':not failures,'runs':len(rows),'failures':failures,'rows':rows,'limitations':'Inherited projection/hold dynamics remain illustrative. Actual speed/acceleration are reported separately; stage labels inherited/avoidance/emergency do not isolate recovery-only updates. Physical geometry is the simulator point-position model with explicit desired margins, not an airframe mesh.'}
out=source.with_name(source.stem+'_gate.json');out.write_text(json.dumps(report,indent=2));print(json.dumps({'out':str(out),'runs':len(rows),'allPass':not failures,'failures':failures},indent=2))
