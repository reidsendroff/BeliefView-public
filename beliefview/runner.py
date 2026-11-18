"""Episode runner: the only place truth and inference meet, and only through
`Observation` objects (simulator -> policy) and `Command`s (policy -> simulator)."""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from .config import ExperimentConfig, MapConfig, ScenarioSpec
from .dynamics import Navigator, step_pose
from .sensor import LookTracker, Observation, Pose, true_detection_prob_point
from .world import Episode


def run_episode(ep: Episode, policy, spec: ScenarioSpec, m: MapConfig, nav: Navigator,
                exp: ExperimentConfig, trace: Optional[list] = None) -> dict:
    T = exp.deadline
    pose = ep.observer0
    # ONE look gate for every policy, applied to whatever pose the policy reaches: a policy
    # that is travelling senses on exactly the same rule as one that is holding or scanning.
    tracker = LookTracker(spec.true_sensor.look_period)
    policy.begin(pose, ep.last_seen_z, ep.last_seen_age)
    dist = 0.0
    t_detect = None
    n_looks = 0
    post_near = None
    for t in range(1, T + 1):
        cmd = policy.decide(t, pose)
        new_pose = step_pose(pose, cmd, nav)
        dist += math.hypot(new_pose.x - pose.x, new_pose.y - pose.y)
        pose = new_pose
        look = tracker.update(pose)
        n_looks += int(look)
        pos = ep.traj[t]
        exited = not np.isfinite(pos[0])
        detected, z = False, None
        if look and not exited:
            # Common random number: the uniform is indexed by time step and shared across
            # policies, but pd depends on THIS policy's viewpoint, so observations differ.
            pd = true_detection_prob_point(spec.true_sensor, m, pose, (pos[0], pos[1]))
            if ep.u[t] < pd:
                detected = True
                s = spec.true_sensor.meas_sigma
                z = (float(pos[0] + ep.noise[t, 0] * s), float(pos[1] + ep.noise[t, 1] * s))
        obs = Observation(t, pose, look, detected, z)
        policy.observe(obs)
        if trace is not None:  # heat is the UNCONDITIONAL per-cell mass (sums to 1 - P(outside))
            trace.append(dict(t=t, pose=pose, subject=None if exited else (float(pos[0]), float(pos[1])),
                              heat=policy.filter.heat().astype(np.float32), out=policy.filter.out,
                              look=look, detected=detected, z=z, decision=policy.trace))
        if detected:
            t_detect = t
            g = policy.model.geo
            near = (g.gx - pos[0]) ** 2 + (g.gy - pos[1]) ** 2 <= 4.0
            post_near = float(policy.filter.b.sum(0)[near].sum())
            break
    f = policy.filter
    rec = dict(scenario=ep.scenario, split=ep.split, idx=ep.idx, policy=policy.name, behavior=ep.behavior,
               found=t_detect is not None, t_detect=t_detect, deadline=T,
               exit_step=ep.exit_step, distance=dist, n_looks=n_looks,
               steps=t_detect if t_detect is not None else T,
               conservation_err=abs(f.total - 1.0), post_mass_near_truth=post_near)
    if t_detect is None:
        # Stated region = CONDITIONAL in-area region (credible_mass of the belief given the
        # subject is still inside). Its unconditional mass is reported separately.
        mask = f.credible_region(exp.credible_mass)
        unc, cond = f.region_masses(mask)
        heat = f.heat()
        pos = ep.traj[T]
        left_true = ep.exit_step is not None
        # Coverage is only defined when the subject is still inside; None (not False) if it left.
        truth_in = None
        if not left_true:
            cx, cy = nav.cell_of(pos[0], pos[1])
            truth_in = bool(mask[cy, cx])
        declared_left = f.out >= exp.tau_left
        rec.update(p_out=float(f.out), region_area=int(mask.sum()), region_uncond_mass=unc,
                   region_cond_mass=cond, truth_in_region=truth_in, truth_left=left_true,
                   declared_left=bool(declared_left), max_cell=float(heat.max()))
    return rec
