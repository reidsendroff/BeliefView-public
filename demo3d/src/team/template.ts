/** Team presentation only. No value from this module enters sensing or policy. */
export interface TeamMarkupChoice {
  fleet: 2 | 3;
  duration: 75 | 180 | 300;
}

export function teamMarkup(choice: TeamMarkupChoice): string {
  const three = choice.fleet === 3;
  const ids = three ? ["A", "B", "C"] : ["A", "B"];
  const countWord = three ? "Three" : "Two";
  const countLower = three ? "three" : "two";
  const sensorMeaning = three
    ? "All three panes are simulated drone cameras from the actual recorded poses and gimbals. Cover stays opaque. An empty view is evidence only where that camera could see; one drone's sighting never counts as another drone's own confirmation."
    : "Both panes are simulated drone cameras from the actual recorded poses and gimbals. Cover stays opaque. An empty view is evidence only where that camera could see; one drone's sighting is never shown as the other's sighting.";
  const taskMethod = three
    ? "Three-drone complementary guidance jointly assigns viewing positions from fresh source-tagged noisy reports, within the same motion limits. Shared-only guidance remains available as a comparator. Reports are noisy local map coordinates, not real GPS or a recipient camera confirmation. Reports expire after 3 s without a fresh update. Own confirmations remain separate from movement tasks; complementary view tasking can continue while a drone has its own fix. Shared-only peer investigation ends on a recent own fix. The 75-second option is a duration reference; this three-drone policy is new behavior. This is noisy-coordinate multi-view positioning, not bearing-only triangulation."
    : "Shared modes also investigate fresh teammate sightings from a complementary known-map viewpoint, within the same motion limits. Reports are noisy local map coordinates, not real GPS or a recipient camera confirmation. Assist expires after 3 s without a fresh report and yields immediately to a recent own fix. The 75-second option is a duration reference; teammate assistance is new behavior.";

  const configuration = `<details id="team-config"><summary>Mission &amp; policy</summary><div class="team-controls">
  <label>Drone count<select id="team-fleet"><option value="2"${three ? "" : " selected"}>Two drones</option><option value="3"${three ? " selected" : ""}>Three drones</option></select></label>
  <label>Team policy<select id="team-arm"><option value="shared">Shared belief</option><option value="independent">Independent beliefs</option><option value="sector">Independent + fixed sectors</option><option value="coordinated">Shared + complementary views (experimental)</option></select></label>
  <label>Terrain<select id="team-terrain"><option value="rich">Mixed forest + water</option><option value="original">Original forest</option></select></label>
  <label>Development mission<select id="team-mission"></select></label>
  <label>Mission duration<select id="team-duration"><option value="75">75 seconds (reference)</option><option value="180">3 minutes</option><option value="300">5 minutes</option></select></label>
</div></details>`;

  return `
<header class="team-head">
  <div class="team-title"><div class="team-eyebrow">Synthetic cooperative search</div><h1>${countWord} drones. One uncertain search.</h1><p>Follow the observations, the belief, and the next move.</p></div>
  <div class="team-head-actions">${configuration}<button id="team-method-open" type="button" aria-controls="team-evidence-panel">Method and limits</button><button id="team-evidence-toggle" type="button" aria-controls="team-evidence-panel" aria-expanded="false">Evidence</button><a id="single-return" href="?">Return to single drone</a></div>
</header>
<div class="team-persistent" role="note">Synthetic simulation / development replay / analytic guidance / known map</div>

<div class="team-policy" role="status" id="team-active"></div>
<section id="team-load" class="team-load" aria-live="polite"><div class="team-eyebrow">Local computation</div><h2 id="load-title">Preparing a ${countLower}-drone replay</h2><p id="load-message">Computing the full deterministic ${choice.duration} s mission in a local worker. Controls remain available while ${three ? "all three" : "both"} drones and their observations are simulated.</p><p id="load-elapsed"></p><button id="team-cancel">Cancel computation</button> <button id="team-retry" hidden>Retry</button></section>
<div id="team-ready" data-fleet="${choice.fleet}" hidden>
  <div class="team-sensors" aria-label="Actual simulated sensor views">
    ${ids.map((id) => `<section class="team-camera-card" data-drone="${id}"><div class="team-camera-label"><strong>DRONE ${id} / SENSOR</strong><span id="sensor-status-${id}">No accepted fix yet</span></div><div class="sensor-tag">SIMULATED CAMERA ${id} / 72° HFOV</div><div class="team-sensor" id="sensor-${id}" role="img" aria-label="Drone ${id} simulated camera"><div class="team-annotation" id="annotation-${id}" aria-hidden="true" hidden>${three ? "" : "<span></span>"}</div></div>${three ? `<div class="team-annotation-key" id="annotation-key-${id}" role="group" aria-label="Drone ${id} camera marker key"><span class="team-annotation-key-item"><i class="team-annotation-key-swatch own" aria-hidden="true"></i>Own noisy report</span><span class="team-annotation-key-item"><i class="team-annotation-key-swatch prediction" aria-hidden="true"></i>Predicted position / no fix</span></div>` : ""}<div class="sensor-footer"><span id="sensor-flight-${id}"></span><span>OPAQUE COVER</span></div><p class="team-note team-gps" id="gps-${id}"></p></section>`).join("")}
  </div>
  <section class="team-overview" aria-label="Mission overview">
    <div class="team-camera-label"><strong>MISSION OVERVIEW</strong><span id="spectator-focus-label">Evaluation only / follows Drone A</span></div>
    <div id="spectator-pane" role="img" aria-label="Evaluation-only spectator view"><div class="pane-heading">SPECTATOR VIEW <span id="cutaway-label">CUTAWAY: ON</span></div></div>
    <div class="team-overview-controls">
      <label class="team-focus-label">Overview focus <select id="team-focus" aria-label="Spectator drone focus">${ids.map((id) => `<option value="${id}">Drone ${id}</option>`).join("")}</select></label>
      <nav class="team-cameras" aria-label="Spectator camera">${(["cinematic", "chase", "ground", "orbit"] as const).map((c, i) => `<button data-camera="${c}" aria-pressed="false">${c[0].toUpperCase() + c.slice(1)} <small>${i + 1}</small></button>`).join("")}</nav>
      <div class="team-toggles"><label><input id="team-cutaway" type="checkbox" checked> Spectator cutaway</label><label><input id="team-truth" type="checkbox"> Evaluation truth</label><label><input id="team-frustum" type="checkbox" checked> A camera frustum</label></div>
      <p class="team-note" id="team-subject-state" hidden></p>
      <p class="team-note team-focus-note">Chase and Cinematic use the selected drone. Ground frames the subject; Orbit is manually controlled.</p>
    </div>
  </section>
  <aside class="team-evidence" id="team-evidence-panel" aria-label="Mission evidence" tabindex="-1">
    <div class="team-evidence-head"><div class="team-eyebrow">Inspectable evidence</div><button id="team-evidence-close" type="button" aria-label="Close evidence panel">Close</button></div>
    <section class="team-overlay-controls" aria-label="Analysis display controls"><h3>Analysis display</h3>${[
      ["mass", "Analytic model mass"],
      ["predict", "Own motion prediction"],
      ["plans", "Recorded planned views"],
      ["marks", "Accepted position marks"],
      ["annotations", "Own camera annotations"],
      ["fill", "Subtle mass fill"],
    ]
      .map(
        ([key, label]) =>
          `<label><input type="checkbox" id="team-overlay-${key}"> ${label}</label>`,
      )
      .join(
        "",
      )}<p class="team-note" id="team-overlay-source"></p><p class="team-note">95% model mass / uncalibrated. Dashed motion: own Kalman extrapolation, 3 s approximate corridor. Plans are recorded intentions, not executed paths.</p><p class="team-note">Raw sensor image with optional own-report annotations. Solid bracket: Own noisy report. Dashed marker: Predicted position / no fix. These mark reported positions, not detected body bounds.</p></section>
    <h2 id="belief-title">Analytic shared belief</h2><p id="belief-age" class="team-note"></p><div class="team-beliefs" id="belief-maps"></div>
    <p class="team-note">Color shows model mass on 6 m cells across a 192 m square. ${three ? "A is gold, B is blue, C is purple" : "A is gold, B is blue"}; the box marks the public initial region and dots mark known trunks. Visible-mass utility is not a probability of finding the subject. This is an approximate analytic filter, not calibrated confidence. The exact static map is supplied in advance.</p>
    <div class="team-ledger">${ids.map((id) => `<section><h3>DRONE ${id}</h3><p id="evidence-${id}"></p><p id="intent-${id}"></p><p id="assist-${id}"></p><p class="muted" id="recovery-${id}"></p></section>`).join("")}</div>
    <section class="team-view-meaning" aria-label="View meanings"><p class="team-note">${sensorMeaning}</p><p class="team-note">Evaluation-only spectator camera (not available to the drones). Orbit supports drag and zoom. Cutaway and truth markers never affect sensing, belief or ${three ? "any" : "either"} sensor image.</p></section>
    <details id="team-method"><summary>Method, limitations and replay diagnostics</summary>
      <p>Team mode uses analytic evidence updates and a known-map view heuristic. ONNX is not loaded or used here. Independent and fixed-sector modes keep separate beliefs; shared modes deduplicate source-tagged observations and visible empty regions. ${taskMethod} Complementary allocation is experimental and has not demonstrated superiority over shared-only guidance.</p>
      <p>These are selected development replays with a scripted reactive subject. Existing single-drone model results and earlier team experiments do not establish performance for this repaired controller. No untouched final team audit has been run.</p>
      <p>Motion uses a synthetic point-position model, desired obstacle margins and a hard 4 m pair separation. Local detours and emergency holds are engineering heuristics. All modes use the same short-escape and live detour-reservation layer for physical coordination; independent beliefs still do not share target observations. Inherited collision projection and holds can produce acceleration discontinuities; this is not real-flight assurance. Drone rigs and guide lines are spectator aids excluded from sensor panes.</p>
      <p>At startup the subject is actually outside ${three ? "all three" : "both"} sensors' detection conditions. A broad public start region is independent of the hidden route. ${three ? "All three" : "Both"} drones sense every 0.05 s; empty-view updates are batched at 0.5 s. Routine plans run at 1.5 s; fresh teammate reports can trigger earlier dispatch. Correlated views are combined by covered subcell union, not treated as independent repeated evidence.</p>
      <p>Simulated GPS uses an arbitrary origin of latitude 45.000000, longitude -93.000000. Local +x is east and +z is north (down on the local belief grid). This small-area display conversion does not georeference the forest or simulate GPS hardware. Six decimal places are display precision, not accuracy; altitude remains AGL.</p>
      ${three ? `<p>The subject's cover policy receives separate delayed, noisy drone-position cues. It follows reachable destinations and attempts cover rather than reading current drone visibility. Standing, crouched, kneeling and prone poses share the same articulated body geometry with rendering and collision checks. The synthetic detector tests nine body samples; a sighting still requires that drone's own field of view, range and physical line of sight. Empty-view evidence uses a conservative public pelvis-column test, not hidden posture. New rich-forest rocks and logs use shared physical face geometry; surface moss and litter are visual detail. Holding a cover attempt does not guarantee actual concealment.</p>` : ""}
      <p id="team-performance"></p><p id="team-outcome"></p><p id="team-provenance"></p>
    </details>
  </aside>
</div>
<input id="team-link-fallback" class="team-link-fallback" aria-label="Replay link" readonly hidden><p id="team-toast" role="status" class="team-note"></p>
`;
}
