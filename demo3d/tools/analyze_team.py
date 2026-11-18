"""Post-hoc descriptive development analysis. Primary follows approved brief, correcting candidate1 metadata."""
import json, math, random, statistics, sys, hashlib
from pathlib import Path
source=Path(sys.argv[1] if len(sys.argv)>1 else 'ml/results/team_development_candidate1.json')
data=json.loads(source.read_text())
if not data['complete']: raise SystemExit('Wait for complete candidate evidence')
arms=['independent','sector','shared','coordinated']
def mean(x): return statistics.mean(x)
def paired(rows, comparator, metric):
    delta=[r['arms']['coordinated']['metrics'][metric]-r['arms'][comparator]['metrics'][metric] for r in rows]
    rng=random.Random(610331)
    boot=sorted(mean(rng.choices(delta,k=len(delta))) for _ in range(4000))
    sd=statistics.stdev(delta)
    n=math.ceil(((1.959964+.841621)*sd/3)**2)
    return {'candidate':'coordinated','comparator':comparator,'metric':metric,'n':len(delta),'meanDeltaS':mean(delta),'bootstrap95':[boot[100],boot[3899]],'pairedSdS':sd,'approximateNormalN80Power3s':n,'proposedRoundedN':max(80,math.ceil(n/20)*20),'withinCap200':n<=200,'worseOver2s':[{'worldSeed':r['worldSeed'],'deltaS':d} for r,d in zip(rows,delta) if d>2], 'deltasS':delta}
summary={}
for family in ['original','rich']:
    rows=[r for r in data['rows'] if r['family']==family]
    summary[family]={
      'primary':paired(rows,'independent','totalNoFixS'),
      'primarySecondaryComparators':[paired(rows,a,'totalNoFixS') for a in ['sector','shared']],
      'secondaryCappedInitialFinding':paired(rows,'independent','initialAcquisitionS'),
      'arms':{a:{'n':len(rows),'meanNoFixS':mean([r['arms'][a]['metrics']['totalNoFixS'] for r in rows]),'meanCappedInitialS':mean([r['arms'][a]['metrics']['initialAcquisitionS'] for r in rows]),'neverFound':sum(not r['arms'][a]['metrics']['initialAcquired'] for r in rows),'meanHoldS':mean([r['arms'][a]['diagnostics']['holdSeconds'] for r in rows]),'maxHoldS':max(r['arms'][a]['diagnostics']['holdSeconds'] for r in rows),'meanHorizontalTravelM':mean([r['arms'][a]['diagnostics']['horizontalTravelM'] for r in rows]),'maxActualAccelerationMps2':max(r['arms'][a]['diagnostics']['maxActualAccelerationMps2'] for r in rows),'minimumSweptSeparationM':min(r['arms'][a]['diagnostics']['minSweptSeparationM'] for r in rows),'waterFrames':sum(r['arms'][a]['diagnostics']['waterFrames'] for r in rows),'subjectPenetrationFrames':sum(r['arms'][a]['diagnostics']['subjectPenetrationFrames'] for r in rows)} for a in arms},
      'generationAttempts':[r['generation']['attempts'] for r in rows]
    }
report={'role':'development, not final audit','source':str(source),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'analysisSourceSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'primaryCorrection':'Approved brief primary totalNoFixS; candidate1 evaluator metadata incorrectly labels initialAcquisitionS primary. No endpoint switch.','powerMethod':'Normal paired-difference approximation, two-sided alpha .05, 80% power for 3s; development-based estimate, not guaranteed power. Final n not selected by this script.','summary':summary}
out=source.with_name(source.stem+'_analysis.json');out.write_text(json.dumps(report,indent=2));print(out)
for family,s in summary.items(): print(family,json.dumps({k:v for k,v in s['primary'].items() if k not in ['deltasS','worseOver2s']}))
