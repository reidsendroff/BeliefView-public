"""Descriptive episode-level diagnostics from complete raw traces, never an inference input."""
import gzip, hashlib, json, math, statistics, sys
from pathlib import Path
source=Path(sys.argv[1] if len(sys.argv)>1 else 'ml/results/team_development_candidate2.json')
data=json.loads(source.read_text())
if not data['complete']: raise SystemExit('Requires complete raw evaluation')
mean=statistics.mean
arms=['independent','sector','shared','coordinated']
rows=[]
for row in data['rows']:
    traces={}
    record={'family':row['family'],'worldSeed':row['worldSeed'],'arms':{}}
    for arm in arms:
        raw=row['arms'][arm];path=Path(raw['tracePath']);contents=path.read_bytes()
        assert hashlib.sha256(contents).hexdigest()==raw['traceSha256']
        trace=json.loads(gzip.decompress(contents));traces[arm]=trace
        epoch_values=[]
        for epoch in trace.get('beliefEpochs',[]):
            sensors=epoch['sensors']
            if arm in ('shared','coordinated'):
                assert sensors[0]['probability']==sensors[1]['probability']
                sensors=sensors[:1]
            for sensor in sensors:
                assert all(math.isfinite(v) and v>=0 for v in sensor['probability'])
                assert abs(sum(sensor['probability'])-1)<1e-8
                epoch_values.append(sensor)
        assert epoch_values
        diag=raw['diagnostics']
        record['arms'][arm]={
            'epochCount':len(trace['beliefEpochs']),
            'meanModelMass95Coverage':mean(v['massRegion95ContainsTruth'] for v in epoch_values),
            'meanModelMass95AreaM2':mean(v['massRegion95AreaM2'] for v in epoch_values),
            'meanTrueCellNll':mean(v['trueCellNll'] for v in epoch_values),
            'meanGridMeanErrorM':mean(v['meanErrorM'] for v in epoch_values),
            'maxActualSpeedMps':diag['maxActualSpeedMps'],
            'maxActualAccelerationByStageMps2':diag['maxActualAccelerationByStageMps2'],
            'maxInheritedProjectionCorrectionM':diag['maxInheritedProjectionCorrectionM'],
            'avoidance':diag['avoidance'],
        }
    base=traces['independent']['frames']
    for arm in arms[1:]:
        fr=traces[arm]['frames']
        record['arms'][arm]['meanSubjectPathDivergenceFromIndependentM']=mean(math.hypot(a['subject']['x']-b['subject']['x'],a['subject']['z']-b['subject']['z']) for a,b in zip(base[:-1],fr[:-1]))
    rows.append(record)
summary={}
for family in ('original','rich'):
    subset=[r for r in rows if r['family']==family];summary[family]={}
    for arm in arms:
        a=[r['arms'][arm] for r in subset]
        summary[family][arm]={k:mean(r[k] for r in a) for k in ['meanModelMass95Coverage','meanModelMass95AreaM2','meanTrueCellNll','meanGridMeanErrorM']}
        summary[family][arm].update({
            'nIndependentScenarioPairs':len(a),
            'meanAvoidanceTriggers':mean(r['avoidance']['triggers'] for r in a),
            'meanAvoidanceNoFeasiblePairSteps':mean(r['avoidance']['noFeasiblePair'] for r in a),
            'meanCountedDeadlocks':mean(r['avoidance']['deadlocks'] for r in a),
            'maxActualSpeedMps':max(r['maxActualSpeedMps'] for r in a),
            'maxActualAccelerationByStageMps2':{stage:max(r['maxActualAccelerationByStageMps2'][stage] for r in a) for stage in ('inherited','avoidance','emergencyHold')},
            'maxInheritedProjectionCorrectionM':max(r['maxInheritedProjectionCorrectionM'] for r in a),
        })
        if arm!='independent':summary[family][arm]['meanSubjectPathDivergenceFromIndependentM']=mean(r['meanSubjectPathDivergenceFromIndependentM'] for r in a)
report={'role':'development descriptive diagnostics','source':str(source),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'analysisSourceSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'unit':'First average correlated epochs within episode; each family has32 independent scenario seeds. Shared A/B posterior duplicate collapsed. 95% model mass is not a calibrated confidence claim.','summary':summary,'rows':rows}
out=source.with_name(source.stem+'_diagnostics.json');out.write_text(json.dumps(report,indent=2));print(out);print(json.dumps(summary,indent=2))
