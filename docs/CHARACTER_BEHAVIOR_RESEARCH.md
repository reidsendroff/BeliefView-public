# Research for purposeful simulated movement and hiding

2026-11-15. Primary-source research requested by the user. These are implementation principles for a synthetic game-like character, not evidence about real human behavior or real drone performance. Astra and Claude should critique the concrete adaptation before edits.

## 1. Separate destination choice, steering and animation

Craig Reynolds' [Steering Behaviors for Autonomous Characters](https://www.red3d.com/cwr/steer/gdc99/) separates higher-level goals, steering and locomotion. It describes combining path following and obstacle avoidance to reach goals. Application here: a stable reachable destination and route should drive the character; local avoidance should adjust that route-following motion. Repeated random heading changes or a direct flee vector should not replace destination progress. The anti-loop thresholds below are our design proposal, not a result claimed by the paper.

## 2. Make cover a persistent goal with explicit failure conditions

Jeff Orkin's [Three States and a Plan: The A.I. of F.E.A.R.](https://www.gamedevs.org/uploads/three-states-plan-ai-of-fear.pdf), GDC 2006, describes goal/action planning and contrasts purposeful cover behavior with arbitrary repeated departures. Application here is limited to noncombat NPC navigation: select cover, reach it, adopt a posture, remain while it is useful, and reconsider when conditions invalidate it. A full GOAP framework is not required for this small behavior set; explicit preconditions, outcomes and failure reasons can provide the same clarity. Do not add weapon or attack behavior.

## 3. A good location must both block sight and be reachable

Epic's official [EQS test reference](https://dev.epicgames.com/documentation/en-us/unreal-engine/eqs-node-reference-tests-in-unreal-engine) treats overlap, visibility traces, path existence, path length and path cost as distinct tests. Application here: generate candidate cover points, reject physically invalid or unreachable ones, then score occlusion and travel cost. A nearby rock is not useful cover merely because its distance score is low. Multiple perceived drone contexts should be evaluated independently. This is a design pattern, not a proposal to migrate the app to Unreal.

## 4. Articulate limbs and match movement to the pose

Daniel Holden's [Simple Two Joint IK](https://theorangeduck.com/page/simple-two-joint) derives a bounded two-segment joint solution. It is directly relevant to hips/knees/ankles and shoulders/elbows/wrists. His [Code vs Data Driven Displacement](https://www.theorangeduck.com/page/code-vs-data-driven-displacement) discusses mismatches between animation and controller movement, including foot sliding and contact handling. Application here: use jointed limbs, constrained bend directions, coherent foot contacts and smooth posture transitions. Drive running gait from actual travel, and stop stepping when the character stops. A procedural implementation can improve this demo without first building a motion-capture or learned-animation pipeline.

## Concrete local acceptance proposed for the reviewed plan

- Destinations and traversable routes are explicit. Record route distance remaining and progress; detect repeated revisits and unproductive loops separately from stationary hiding. Freeze thresholds before measuring the new behavior.
- Show a reproducible development episode with sustained actual all-three-drone occlusion for at least five seconds after reaching useful cover, sensors active throughout. Out-of-FOV alone is not proof of good cover.
- Demonstrate a prone, lengthwise position on the far side of a log with actual body-height and horizontal-footprint checks. Test exposure from the log's end and above as well as concealment from the side.
- Render knees and elbows bending naturally, with grounded feet/knees/body and smooth standing/crouched/prone transitions. Use one posture definition for rendered joints, body samples and the sensor's target height.
- Validate that the subject repositions in response to degraded perceived changes, without consuming drone beliefs, actual detection verdicts or hidden planner state. Do not force sensor failures or script a guaranteed search outcome.
- Keep old single/two-drone behavior available and reproducible. Revalidate the new terrain and subject together; prior results cannot establish success for changed geometry or behavior.

## Latest layout requirement

The user watched the three-drone preview and explicitly changed the visual priority: enlarge the three simulated drone feeds and reduce the spectator view. This supersedes the initial requirement that spectator area exceed every sensor pane. Retain four accessible views, evidence to the side where space permits, correct aspect ratios and efficient viewport use.
