# Three-drone local implementation

Status: implementation and targeted checks complete; broad engineering regression and final independent review pending. Local only. Nothing has been merged, deployed or published.

The new `fleet=3` mode has three actual simulated cameras, distinct A/B/C observation noise, independent own-confirmation histories, and a joint motion decision checked against all three continuous pair separations. The complementary policy uses accepted source-tagged position reports to choose different viewing positions around an estimated location. This is multi-view positioning, not bearing-only triangulation: the simulated observations already contain noisy map coordinates. Three drones are an explicit experiment, not a claim that three is optimal or superior to two.

The viewer uses the available desktop width. The spectator is the largest pane, with three smaller 16:9 sensor views and evidence alongside. Compact desktops put the three sensors in a row with an evidence drawer; mobile deliberately stacks the views. Mission, terrain, duration, policy, camera modes, focus, cutaway, truth, GPS, playback, replay links and the single-drone entry remain available. Two-drone URLs remain two-drone unless `fleet=3` is explicit. The same wider layout also applies to two-drone mode.

## Preservation and review

The pre-edit workspace archive and its157-file inventory are kept in a private local baseline (not published; see [PUBLIC_SNAPSHOT.md](PUBLIC_SNAPSHOT.md)), manifest SHA256 `dfca870c2a18efdbafda1f4f50f0c460e6e1dbc9a2163c4288173e9661751671`. The baseline includes rendered evidence and the user's reference images. The plan, exact copy inventory and multiple author-owned Claude critique request/reply pairs were reviewed before implementation and scoped mechanical repairs.

The independent reviewer ran28 archived two-drone cases after the shared interface additions. Every physical/sensor/belief/metric transcript matched exactly, including historical default options and75/180/300 horizons. Evidence: `demo3d/output/three-drone-independent-two-preservation/result.json`. The existing single-drone main, model weights, training provenance and historical results remain unchanged. Team mode still runs an analytic filter using an exact supplied static map, without ONNX inference.

Astra authored the numerical modules and integration; an inherited Astra child owned the viewer layout, transport and third-camera integration. Codex independently reviewed the actual code, preserved transcripts, raw numerical traces and rendered product. The independent review (`THREE_DRONE_REVIEW.md`, an internal record not published here; see [PUBLIC_SNAPSHOT.md](PUBLIC_SNAPSHOT.md)) is the authority for final disposition. The copy inventory (`THREE_DRONE_COPY_INVENTORY.md`, not published here) accounts for moved controls, disclosures and intentional wording changes.

## Numerical behavior and retained failures

New numerical modules are separate from the two-drone runtime. The shared evidence interface explicitly opts into the A/B/C cohort; old callers still reject ghost C packets. The public map and initial positions are independent of hidden target routes. C has its own deterministic noise stream and starts on the opposite side of the public region. Simulation-side admission requires actual initial non-detection for all three; no hidden start, route, action or occlusion verdict enters planning.

The report estimate uses fresh accepted observations, consistency filtering, bounded prediction and explicitly heuristic uncertainty growth. Candidate visibility uses the known geometry and actual sensor FOV/range; utility uses the exact union of subcell masks across three views. This is not a calibrated detection probability. Own-camera confirmation remains separate from a teammate's report. An own-confirmed drone can continue a complementary movement task, while shared-only investigation ends promptly on its own confirmation. Unconfirmed arrivals retry another useful slot before returning to ordinary search.

Three-way motion selects one globally feasible tuple, never a sequence of pairwise fixes. It retains hard geometry/margin checks and4m swept separation for AB, AC and BC. Bounded detour protection and oldest-target right-of-way prevent ordinary following from repeatedly displacing a drone just before it finishes a clearance detour. The owner tier admits tuples within0.05m/s of the true minimum owner deviation, then applies the existing joint cost. Existing12s detour and3s stationary caps are unchanged. Inherited collision projection and emergency hold behavior remain illustrative, with measured actual speed/acceleration; this is not a physically certified flight controller.

Failed development candidates are preserved:

- `three-drone-probe-v1`: one original/shared75s detour-cap failure. All three pair constraints held, but reliability failed.
- `three-drone-probe-v2-fixes`: separate correctness fixes changed trajectories; a rich/shared75s detour failure remained.
- `three-drone-probe-v3-motion`: all four75s runs passed after bounded protection. A motion-only ablation on the frozen v1 policy reproduced the original failure with protection disabled and removed it with protection enabled. Full-band escalation alone did not remove it.
- `three-v3-targeted-300`: the longer original/shared run exposed another near-arrival yielding failure at282.6s. Three other300s runs passed. This prompted reviewed owner arbitration, not larger timeouts.
- `three-v4-targeted-300`: all four300s targeted runs passed with maximum forced/commanded stationary interval0.15s and minimum swept pair distance4.000044791m. Independent raw-trace review agreed. Headless generation/simulation/serialization took13.4-18.4s and payloads were34.4-48.1MB on this machine.

A subsequent counter-only fix attributes non-owner expiry to the actual preceding owner interval; it does not change motion selection. The broad engineering freeze records that final source separately. Development reliability evidence does not establish search-performance superiority, and two-versus-three trajectories/admission differ, so no causal fleet-size comparison is claimed.

## Verification inventory

Current source passed239 tests in25 files and the production TypeScript/Vite build. Logs: `demo3d/output/three-final-unit.log`, `three-final-build.log`. The111-file source/build inventory is `demo3d/output/three-source-build-freeze.json`, SHA256 `03cd053e25776e4781971bfedd01bc547ddca58b4c0d4471ee62a01d0d6b91f4`.

Before the final numerical freeze, author browser checks passed44 cases and independent Codex viewport checks passed48 cases across1280x720,1440x900,1920x1080,2507x1361,2560x1440,320px and390px. They exercised real canvases, source-specific views, pixel isolation, worker faults, cancellation/retry, schema/cohort validation and layout. These are interim rendering evidence tied to their recorded source version; final full-motion evidence remains pending.

The frozen broad protocol is64x300s development runs,8x180s default-mission runs and32 fresh engineering stress runs. It retains zero blocked events/physical violations, all three pair distances>=4m, raw commanded-stationary and forced-hold windows<=3s, exact cohorts, finite states, normalized1024-cell distributions, bounded payload and local preparation budgets. Reserved final-audit seeds remain untouched. Each report preserves source hashes and raw compressed traces; independent reconstruction is required before approval.
