"""Selected development example only. Fixed noisy-report travel is not true-target error."""
import gzip,hashlib,json,math
from pathlib import Path
old=json.loads(Path('ml/results/team_recovery_v5_engineering.json').read_text())
row=next(r for r in old['rows'] if r['family']=='rich' and r['worldSeed']==220016)
paths={'v2AssistOffControl':'output/team-duration-v2-independent-prefix/rich-shared-75-assist-off-control.json.gz','historicalAssistOff':row['arms']['shared']['tracePath'],'v2AssistOn':'output/team-duration-v2-independent-prefix/rich-shared-75.json.gz'}
timelines={name:json.loads(gzip.decompress(Path(path).read_bytes())) for name,path in paths.items()}
new=timelines['v2AssistOn'];first=next(f for f in new['frames'] if any(a['state']=='investigating' for a in f.get('assist',[])))
cue=next(a for a in first['assist'] if a['state']=='investigating');recipient=cue['id'];source=cue['source'];first_source=next(f['t'] for f in new['frames'] if any(a['id']==source and a['observation'] is not None for a in f['aircraft']))
report={'role':'One illustrative development mission17 rich/shared, not a general performance comparison','firstSourceObservationS':first_source,'firstAssistCommandS':first['t'],'dispatchLatencyS':first['t']-first_source,'recipient':recipient,'source':source,'noisyReportedPosition':{'x':cue['x'],'z':cue['z'],'sigma':cue['sigma']},'runs':{}}
for name,tl in timelines.items():
 fs=tl['frames'];at=lambda f:next(a for a in f['aircraft'] if a['id']==recipient)
 fix=next((f['t'] for f in fs if at(f)['observation'] is not None),None)
 start=round(first['t']/.05);end=min(len(fs)-1,start+200)
 travel=sum(math.dist(tuple(at(fs[i])['state']['pos'][k]for k in ('x','y','z')),tuple(at(fs[i+1])['state']['pos'][k]for k in ('x','y','z')))for i in range(start,end))
 distance=lambda f:math.hypot(at(f)['state']['pos']['x']-cue['x'],at(f)['state']['pos']['z']-cue['z'])
 report['runs'][name]={'trace':paths[name],'traceSha256':hashlib.sha256(Path(paths[name]).read_bytes()).hexdigest(),'recipientFirstOwnObservationS':fix,'first10sTravel3DM':travel,'distanceToFixedNoisyReportStartM':distance(fs[start]),'distanceToFixedNoisyReportAfter10sM':distance(fs[end]),'note':'Different closed-loop drone actions can alter the reactive subject trajectory; no matched-hidden-path causal estimate.'}
p=Path('ml/results/team_duration_v2_assist_example.json');p.write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
