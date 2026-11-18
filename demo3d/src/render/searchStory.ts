/** Presentation only: deliberately accepts no subject, action, cover or simulator visibility verdict. */
import type { Frame } from "../sim/types";
import type { BeliefGrid } from "../ml/belief";
import { findPeaks, hpdRegion, regionAreaM2 } from "../ml/belief";
const summaries = new WeakMap<BeliefGrid, { level: number; count: number; area: number }>();
export type StoryFrame = Pick<Frame, "obs" | "track" | "mode" | "drone" | "viewpoint">;
export function searchStory(f: StoryFrame, b: BeliefGrid | null, level: number | null, learned: boolean) {
  const searching = f.track.status === "SEARCHING";
  const title = !f.track.initialised ? "Establishing the first sighting" : f.track.status === "REACQUIRING" ? "Seen again. Confirming." : f.obs ? "A noisy sighting anchors the track" : searching ? f.drone.agl > 5 ? "Find a route below the canopy" : "Search laterally around cover" : "The sighting has stopped";
  const distance = f.viewpoint ? Math.hypot(f.viewpoint.x - f.drone.x, f.viewpoint.z - f.drone.z) : null;
  const intent = !f.track.initialised ? "Scan the designated coarse start area until the first noisy sighting." : searching
    ? `${f.drone.agl > 5 ? "Find a clear descent route toward low search altitude, then approach" : "Move toward"} the planned viewpoint${distance === null ? "." : `, ${distance.toFixed(0)} m away.`} ${learned ? "The policy weighs possible locations and known-map sightlines; individual plans may use Kalman fallback." : "The policy tests sightlines into the Kalman uncertainty ellipse."}`
    : f.track.status === "REACQUIRING" ? "Gather consecutive fixes before returning to low following."
    : f.obs ? "Follow the observed track. Each fix has measurement noise; the person is not known exactly."
    : "Extrapolate from past fixes. No missing sighting reveals why the person is out of view.";
  let belief = !f.track.initialised ? "No accepted fix yet" : f.obs ? `Fix uncertainty: ${f.obs.sigma.toFixed(1)} m (1 sigma)` : `No fix for ${f.track.age.toFixed(1)} s`;
  if (b && !f.obs && level !== null) {
    let summary = summaries.get(b);
    if (!summary || summary.level !== level) {
      summary = { level, count: findPeaks(b, 3, 2, 0.05).length, area: Math.round(regionAreaM2(hpdRegion(b, level).cells)) };
      summaries.set(b, summary);
    }
    const { count, area } = summary;
    belief += ` | ${count} probability peak${count === 1 ? "" : "s"} | ${area.toLocaleString("en-US")} m² region`;
  } else if (!f.obs && f.track.initialised) belief += ` | Kalman radius ${f.track.radius.toFixed(0)} m`;
  return { title, intent, belief };
}
