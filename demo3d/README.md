# BeliefView 3D — illustrative drone search simulation

A **separate, self-contained** 3D demo: a simulated drone follows a simulated **evasive subject** (it sprints, jinks,
feints/reverses, runs to nearby trees and crouches there, then breaks cover) through a procedural forest, loses the
subject behind trees, **descends below the canopy and moves sideways** to search, and re-acquires the subject only when
real line-of-sight, field-of-view and range allow it.

> **This is a synthetic, illustrative simulation.** It is not a real drone, not a flight controller, not
> validated 3D performance, and it is **not** the frozen BeliefView v2 filter or any v2 metric. The v2
> experiment in the parent repo is 2D (no altitude). Nothing here reuses its code, parameters or results, and no
> number from this demo should be compared with v2 numbers. A persistent banner in the UI says so.

Nothing outside `demo3d/` was changed.

## Run

Requires Node 20+ (developed on Node 26 / npm 11). No network is used at runtime (no CDN, fonts or APIs).

```bash
cd demo3d
npm install        # pinned versions + package-lock.json
npm run dev        # http://localhost:5173  (auto-plays, 75 s, deterministic)
npm run build      # typecheck + production bundle in dist/
npm run preview    # serve dist/
npm test           # vitest: tests (simulation/sensing, evasive-subject, spectator framing)
npm run typecheck
```

URL params for demos/screenshots: `?t=21&paused=1&cam=chase|ground|orbit|cinematic&truth=1&speed=0.5`.

## What you see

* Procedural low-poly woods (seeded; ~860 instanced trees, terrain, rocks, undergrowth), dirt trail, shadows, fog.
* Evasive subject (orange jacket): walks, then sprints with a forward lean, jinks, feints/reverses, runs to a nearby tree,
  **crouches** behind it, and breaks cover. Gait, lean, bank-into-turn and crouch are animated from the recorded subject
  state. An evaluation-only fading footprint trail of its true recent path (render-only, off by default, toggle `L`, only available while the ground-truth marker `T` is on; turning truth off turns it off) can be shown.
* Drone (oversized for legibility) that moves **horizontally and vertically**: cruise ~24 m AGL → descends to ~3 m under
  the canopy while moving sideways → follows low → climbs back when an open column exists.
* **Camera presentation**: the main view is always an **evaluation-only spectator camera** that the drone does not have; the
  **inset** is the simulated drone camera. A persistent label under the main view says so
  ("Main view: evaluation-only spectator camera (not available to the drone) · Inset: simulated drone camera").
  In **Cinematic** the spectator eases from the wide forest/drone shot into a nearby close shot while the *recorded* subject
  action is sprint / jink / feint / running-to-cover (side or three-quarter view of the runner) and hide / break-cover
  (side view of the crouched person and their tree). The shot weight is a pure, smoothed function of the recorded frames
  (subject action and tracker status), so it is identical in playback and after scrubbing. The viewpoint is picked among
  nearby candidates by clear line of sight / trunk clearance. This is render-only: it never changes the simulation, the
  observations, the tracker or the subject's visibility, and it shows no action text (that stays behind the `T` toggle).
* Cameras: **Cinematic** (auto, default), **Chase** (behind drone, looks where its gimbal looks), **Ground**, **Orbit** (mouse).
* **Drone-cam inset**: a second render from the drone's gimbal using the same FOV model as the simulation.
  It shows a green "LOCK" box when a fix exists, or a dashed amber "predicted position" ring when it does not.
* HUD (always shown, no subject truth): track status chip (TRACKING / COASTING / SEARCHING / REACQUIRING), drone mode, AGL, speed, time since last
  fix, prediction radius, sensor diagnostics (LOS / FOV / range), altitude gauge with the canopy band, belief map,
  caption, event toasts. With the evaluation-only ground-truth toggle (`T`) on, an extra panel shows the subject's true action
  and speed.
* Overlays: prediction corridor (widens with time horizon), uncertainty disc/column, observed-track history (filtered
  estimate on frames with a fix), camera frustum, planned search viewpoint.
* Timeline: play/pause, restart, 0.5×/1×/2×, scrubber, clickable event chips (derived from the run, not scripted).
* Keys: `Space` play/pause, `←/→` ±2 s, `R` restart, `1–4` cameras, `P` prediction, `F` frustum, `M` map, `C` canopy see-through, `T` truth marker (+ true subject action), `L` subject true-path trail (evaluation only; needs `T`).

## Architecture

```
src/sim/        pure, deterministic, no DOM/Three.js (what the tests exercise)
  rng.ts        mulberry32 seeded PRNG
  world.ts      terrain function + seeded trees (trunk cylinders, canopy spheres) + dense "grove"
  route.ts      scenario setup: trail polyline + destination waypoints (world generation / trail art / subject goal only)
  subject.ts    hand-written evasive finite-state agent (own seeded RNG, speed/accel/turn limits) + delayed/noisy drone perception
  geometry.ts   analytic segment/sphere + segment/cylinder tests, terrain ray-march, clearance projection
  sensor.ts     camera model: 72° HFOV, 16:9, 38 m max range (shared with the renderer)
  tracker.ts    constant-velocity Kalman tracker; imports only ./types (checked by a test)
  drone.ts      mode logic + viewpoint search + kinematics + gimbal; sees only the tracker belief + a known map
  simulate.ts   fixed-step (20 Hz, 75 s) co-simulation of subject + sensor + tracker + drone -> Frame[]; derives timeline events
  playback.ts   frame interpolation for smooth rendering
src/render/     Three.js + DOM only; reads the Timeline, never feeds back into it
  stage.ts      scene, drone, subject (gait/lean/crouch from recorded state), footprint trail, overlays, cameras, inset pass
  hud.ts        DOM HUD, minimap, timeline chips, toasts
src/main.ts     player loop (time, scrub, speed, keys)
tests/sim.test.ts      sensing / tracker / drone / event tests
tests/subject.test.ts  evasive-subject coverage, kinematics, cover legitimacy, determinism, truth separation
```

The whole run is precomputed once at load (≈1 s) into 1501 frames (the subject, drone, sensor and tracker are
co-simulated step by step and every state is recorded per frame); the player just samples it. That makes
scrubbing, replay and determinism trivial and keeps simulation and rendering separate.

### The evasive subject (exact, simple, hand-written)

A deterministic finite-state agent with **its own seeded RNG stream** (`subjectSeed`, separate from the sensor-noise
stream so the observation noise does not change when the subject policy changes). It is a hand-written rule set, **not
learned and not a model of any real person**; every constant was chosen by hand to make the behaviours visible.

* States: `TRAVEL` (walk toward the destination waypoints; oblivious until it first notices the drone at ≈3.4–4.6 s) →
  `SPRINT` (5.3–6.3 m/s, heading = blend of "away from the drone" and "toward the goal") with periodic `JINK`s (35–70° zig-zag
  offsets) → `FEINT` (fake to one side, then cut back ≈130° the other way, preferring the side with open ground) →
  `SEEK_COVER` → `HIDE` → `RESUME` (break cover sideways and sprint) → …
* Limits: speed ≤ 6.3 m/s, acceleration 4.5 m/s², braking 7 m/s², lateral acceleration ≤ 8.5 m/s² (so turn rate falls with
  speed; it slows for sharp turns), turn rate ≤ 4.5 rad/s, always on the terrain, inside the map, steering around trunks and a
  hard 0.3 m trunk clearance (no collisions, no teleports).
* **What the subject can know:** its own state, the static trees within ~30 m, and a **delayed (0.8 s), noisy (2.5 m 1σ,
  refreshed 4×/s, low-pass filtered) estimate of the drone's position** (as if it heard/glimpsed the drone). It never receives
  the drone mode, the tracker belief, the gimbal direction, the planned viewpoint or the sensor's visibility result, and
  `subject.ts` imports nothing from `drone`/`tracker`/`sensor` (tested; the agent is also replayed from recorded drone positions
  alone to reproduce every subject frame).
* **Cover:** the subject only starts to hide at a spot behind a tree (relative to the *perceived* drone position) where its own
  estimate, using the same static tree geometry, says the line to a crouched torso is blocked (also for ±1.5 m shifts of the
  estimate). It hides only after arriving there, holds ≥ 2.5 s (3–5 s drawn), crouched and nearly still, and breaks cover earlier
  only after the minimum hold if the perceived drone comes within 10 m or its estimate says the cover no longer shields it. The
  "hiding" label is therefore only ever shown (evaluation panel) while crouched at such a tree. The estimate is not the real
  visibility: the drone sometimes still sees a "hidden" subject, and the subject sometimes hides where the drone cannot be seen from.
* The subject is **never** told it is lost or found: loss/reacquisition come only from the geometric sensor model below.

### How the logic works (exact, simple)

1. **Sensing.** Each step, the subject (torso point, ground + 1.3 m) is *visible* iff it is within 38 m, inside the
   gimbal camera's frustum, **and** the analytic line of sight from the camera to it hits no trunk cylinder, canopy
   sphere or terrain. The result is a reason code (`OCCLUDED_CANOPY`, `OCCLUDED_TRUNK`, `OUT_OF_FOV`, …).
2. **Observation.** If visible, the tracker is handed a noisy ground-plane fix `(x, z, σ)` (σ = 0.4 m + 2 % of range).
   Otherwise it gets nothing.
3. **Tracker.** Constant-velocity Kalman filter. With no fix it only extrapolates the last position/velocity and its
   covariance grows (process noise: 1.1 m/s² 1-σ acceleration). Status is derived from time since last fix:
   `< 0.5 s` TRACKING, `< 1.5 s` COASTING, otherwise SEARCHING; after a fix following SEARCHING it is REACQUIRING
   until 3 consecutive fixes.
4. **Drone guidance** (belief + known static map only):
   `FOLLOW_HIGH` (24 m AGL, 14 m behind the believed heading) → on SEARCHING → `SEARCH`: every 1 s pick, from 48
   candidate low viewpoints on rings of 7/12/18 m around the belief, the one with the best predicted line of sight
   into the belief ellipse (5 sample points, known map). It first drops (≤ 3.4 m/s down) through an open column of
   the known map to ≈5 m AGL, then travels to that viewpoint at ≈3 m AGL, and sweeps the gimbal laterally across the uncertainty. After 3 confirming fixes → `FOLLOW_LOW` (3.5 m AGL, 9 m
   behind) for 8 s → `CLIMB` (only through an open canopy column; otherwise slides to the nearest gap) → `FOLLOW_HIGH`.
   Speed/acceleration/gimbal-slew limits, ≥ 2 m terrain clearance and ≥ 1 m trunk/canopy clearance are enforced every step.
5. **Timeline markers** (occluded, search begins, enters canopy layer, below canopy, reacquired, confirmed) are found by
   scanning the recorded frames.

### Truth handling

* The tracker and the drone planner never receive the subject's true position; the tracker module imports nothing
  from the world/subject/sensor code, and a test replays the recorded observations alone to reproduce every
  tracker state, and a second test runs a different subject route/seed and shows tracker/drone/gimbal are bit-identical until the observations differ.
* The orange subject in the 3D scene is the simulated *world*, not the tracker's output. The extra **ground-truth
  marker** (ring, beam, "EVALUATION ONLY" label, plus a square on the belief map, plus the subject's true action/speed in the
  status panel) is **off by default** and toggled with `T`; the true-path footprint trail (`L`) is likewise off by default and only shown while `T` is on. The subject's action is never shown otherwise.
* The gimbal's first aim at t = 0 uses an operator-style initial designation (scenario setup), nothing afterwards.
* HUD "Sensor model (simulation)" rows reveal the simulated visibility; they are diagnostics, not tracker inputs.

## Exact feature claims

* Deterministic: same seeds → byte-identical frames (tested). 75 s, 20 Hz fixed timestep.
* The subject stays on the ground and out of trunks the whole run (tested speed/acceleration/turn limits); the drone changes both
  altitude and horizontal position.
* Occlusion and re-acquisition are computed from geometry every frame (tested by independent recomputation).
* In the shipped scenario (world seed 79, subject-policy seed 40) the recorded run is, in evaluation terms: walking until ≈4.2 s;
  sprinting/jinking from 4.2 s (peak 6.2 m/s); first loss of the subject at ≈5.2 s, search begins ≈6.2 s; the subject runs to a
  tree and **hides crouched 11.3–14.3 s (3.0 s)**; the drone is below the canopy band at ≈12.0 s and reacquires at ≈14.4 s (the
  last 0.1 s of the hide), i.e. ≈2.4 s and ≈8 m of low horizontal search *before* the first fix, with the track unseen for ≈9 s and
  the prediction radius growing the whole time. The subject then resumes, feints/reverses (21.0–23.4 s, 31.1–33.5 s, 51.1–53.5 s,
  70.2–72.6 s), hides again (41.1–43.6 s, 58.3–62.9 s) and is lost again at ≈55 s until ≈65.8 s. Event times are derived and change
  if any parameter changes; tests enforce the order and the minimum low-search duration/distance. The subject seed was chosen from
  a sweep (against the same low-search-before-fix thresholds as before and the behaviour requirements) so the story is visible;
  this is scenario selection, not evidence of general performance.

## Limitations (read before presenting)

* **The subject policy is hand-written and illustrative.** It is a small rule set with hand-tuned constants, not a validated
  model of how a real person flees or hides; it uses a simplified perception (delayed, noisy drone position, a known tree map)
  and a one-line cover test, and its cover can fail (the drone may still see it). Other subject seeds give different, sometimes
  much less dramatic, runs.
* **Illustrative, not validated.** Constants were hand-tuned so the story is visible; there is no calibration to any
  real sensor, drone, forest or person, and no performance claim.
* The seeded scenario was tuned; re-acquisition took ~9 s from the first loss. Other seeds/routes may behave differently
  (or lose the target for good); only this seed is covered by tests.
* Occluders are spheres + cylinders; the visible meshes are approximations of them (leaf lumps stay inside the
  sphere). Foliage is opaque and perfectly blocking; the real world has gaps and partial occlusion.
* Search is a greedy one-step viewpoint heuristic with a known map, not a belief-space planner. The tracker is a
  ground-plane Kalman filter with a single covariance; it does not model altitude, maps, or multiple hypotheses.
* Subject appearance, detector errors and false positives are not modelled; a fix is a noisy ground-truth position. The subject has a
  simple capsule body: no foot placement, no stumbling, no use of undergrowth, rocks or terrain for hiding (only trees).
* The CLIMB phase can stay low for a long time in dense grove; during it the drone sometimes loses the track again briefly.
* Ground camera is weak inside the dense grove (trunks fill the view); Cinematic / Chase are the intended showpieces.
* The **canopy see-through** view option is render-only dither; it does not change what the drone camera can see.
* Browser smoke was run with scripted headless Chrome screenshots at several times/cameras (page errors checked, subject true-action hook read); there is no automated interaction suite. Bundle is ~620 kB
  (Three.js), not code-split.

## Learned search guidance (optional, synthetic)

An optional **learned** search mode sits beside the default Kalman mode. A compact ONNX model turns the observation history, elapsed
time, the drone's own pose and the known map into a **probability grid over where the subject may be** once fixes stop (several
peaks, including cover behind trees). Search viewpoints are scored against that weighted set of locations (map line of sight,
camera range/FOV); physical limits (speed/acceleration/clearance/gimbal slew), the sensor model, the subject policy and the Kalman
tracker are unchanged.

* Select it in the **Search guidance** panel (Kalman is the default) or with `?guidance=ml`. The page then loads
  `public/models/beliefview3d-search-v1/manifest.json` + `model.onnx` with the pinned `onnxruntime-web` (wasm, served from this app,
  no CDN), validates the manifest schema/version and the model's sha256, and computes the run asynchronously with predictions at
  fixed simulation steps (every 1.0 s of simulated time while the fix is missing), so playback is deterministic for a fixed
  model + seed. If anything fails, the status line says so, the Kalman run is used, and the selector and an "Active guidance" line show **Kalman (fallback)** rather than the requested Learned mode.
* Visuals (learned mode only): violet probability heat on the terrain and minimap, white outline of the **validation-calibrated region (target 95 %)**,
  numbered peak rings with short (<= 1 m) ground posts, and a readout of peak masses / region area / entropy / **measured held-out coverage** (from the manifest; not a guarantee); toggle with `G`. While learned mode is on, the existing Prediction toggle is labelled as the Kalman tracker's corridor. The overlay is a spectator-view
  overlay only (not in the drone-camera inset).
* **Trust boundary:** the model features accept only past/current noisy observations, elapsed time, drone pose and the known map
  (`src/ml/features.ts`). Subject truth, action, chosen cover and the sensor's visibility verdict never reach the model or the
  drone; truth is used only for training labels, held-out evaluation and the existing ground-truth-gated display. For the learned
  path **no start position is a model input** and the model is never run before the first noisy fix; the drone is set up from a *coarse* designated area (the 16 m cell containing the scenario's first waypoint; computed from the scenario configuration, never from subject state, deliberately not the exact start). The browser's Kalman demo (default and error fallback) uses the same coarse set-up, so no subject state reaches the drone at inference; the legacy exact-start `simulate()` default is kept only as an evaluation-only reference (`tools/eval_closed_loop.ts`, tests).
* Training, ONNX export, manifest, parity fixtures and the measured results live in [`ml/`](ml/README.md) (Colab-compatible notebook,
  `ml/RESULTS.md`). **The model is trained only on this simulator's synthetic episodes and says nothing about real people,
  drones or forests; no improvement over Kalman is claimed beyond what `ml/RESULTS.md` measures.**

```bash
npm test                 # vitest, incl. leakage / manifest / ONNX parity / determinism tests (needs the committed model)
npm run build && npm run test:browser   # real Chromium: model fetch + inference + guidance + overlay + fallbacks
npm run ml:gen -- --split val --count 5 --out /tmp/val.jsonl.gz      # JSONL samples from the real TypeScript simulator
npm run ml:eval -- --model public/models/beliefview3d-search-v1 --count 20 --out /tmp/cl.json
```

## Search-story presentation and replay selection

The local search-story pass keeps the trained model, simulator and camera behavior unchanged while giving the scene more space. "Explore scenario & controls" contains the deterministic scenario selector, both guidance choices, overlay settings and model evidence. Flight/sensor diagnostics remain in their own details. The active policy (including fallback), synthetic banner, camera controls, playback and drone inset remain visible. On short phones the explanations/details scroll.

Three URL scenarios are available: `?scenario=original`, `?scenario=forest` (development test-0), and `?scenario=challenge` (retained ML-worse development test-46). Add `&guidance=ml` to run the exported model. "Copy replay link" preserves scenario, camera, speed, current time and truth setting, with playback paused. Changing guidance preserves camera/speed/time; changing scenario restarts at time zero.

The new search-story explanation reads only recorded observation/tracker/drone/viewpoint state and the learned distribution. It does not reveal hidden subject actions or why a sighting is missing. It describes the existing heuristic, including possible per-plan fallback, without claiming exact reacquisition probabilities. Different guidance paths can induce different subject paths, even from the same seed.

The earlier approximate 1 s simulation-precompute figure excludes spectator-camera preparation. New runtime details report navigation-to-first-render for the selected replay time, separately from inference. Loading directly into a close shot exercises lazy camera preparation; a time-zero first frame may defer it. See the [implementation and measurement report](../docs/ASTRA_SEARCH_STORY_REPORT.md). The independent review it refers to is an internal record that is not published (see [PUBLIC_SNAPSHOT](../docs/PUBLIC_SNAPSHOT.md)).

```bash
# Separate new evidence; preserves the historical browser_smoke.json.
BV_SHOT_DIR=output/playwright BV_REPORT_PATH=ml/results/search_story_smoke.json npm run test:browser
BV_HEADED=1 node tests/browser/presentation.mjs  # built app, scenarios, failures, controls, sizes, full camera episodes
npx tsx tools/eval_presentation.ts   # selected illustrative examples only, not a new audit
```
