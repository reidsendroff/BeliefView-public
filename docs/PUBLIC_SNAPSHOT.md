# About this public snapshot

This repository is a **public snapshot with its own new Git history (no private history)** of a project that was developed privately with AI assistance (Claude, under Codex's orchestration and independent review; see [CONTRIBUTIONS.md](../CONTRIBUTIONS.md)). It was prepared for publication by leaving out internal process records. No research content was changed: source, tests, frozen configs, frozen data and results, the archived v1 record, the 3D demo, the trained model and its manifest, figures, clips, attribution and the limitations are all as they were.

## What is not published

The following internal records are **not** in this repository. They were working documents (task briefs, plans, review ledgers and inventories) containing local machine paths, personal identifiers and private repository details. Where a retained document still names one of them, it is a reference to an unpublished record, not a broken link to something you can fetch.

Repository root:

- `PROJECT_BRIEF.md`, `WORK_PLAN.md`, `FABLE_FIX_BRIEF.md`, `DEMO_PASS_PLAN.md` (the plan that fixed the v2 protocol before any v2 episode existed), `DEMO_REVIEW_FIX_BRIEF.md`, `FINAL_REVIEW_FIX_BRIEF.md`, `REPO_DOCS_PLAN.md`
- `REVIEW_NOTES.md` (the independent review record and change ledgers)

`docs/`:

- Plans: `ASTRA_INTELLIGENCE_PLAN.md`, `ASTRA_SEARCH_STORY_PLAN.md`, `TEAM_DURATION_PLAN.md`, `TEAM_GROUND_FRAMING_PLAN.md`, `TEAM_LONG_RECOVERY_PLAN.md`, `TEAM_RECOVERY_DEMO_PLAN.md`, `TEAM_SIMULATED_GPS_PLAN.md`, `THREE_COVER_WORLD_PLAN.md`, `THREE_DRONE_PLAN.md`
- Reviews: `ASTRA_INTELLIGENCE_REVIEW.md`, `ASTRA_SEARCH_STORY_REVIEW.md`, `COOPERATIVE_SEARCH_REVIEW.md`, `TEAM_DURATION_REVIEW.md`, `TEAM_RECOVERY_DEMO_REVIEW.md`, `TEAM_SIMULATED_GPS_REVIEW.md`, `THREE_DRONE_REVIEW.md`
- Briefs, inventories and drafts: `COOPERATIVE_SEARCH_BRIEF.md`, `FOREST_REFERENCE_BRIEF.md`, `THREE_DRONE_COPY_INVENTORY.md`, `THREE_PRESENTATION_CHANGE_INVENTORY.md`, `THREE_LAYOUT_BODY_PROPOSAL.md`, `THREE_SUBJECT_COVER_DRAFT.md`

The retained `docs/` files are the technical report, the implementation/result reports, the research and design notes, and the geometry contract.

## What the omission means for the evidence

- **Reports that cite a review verdict** (for example "approved for the local demo") report what the unpublished review recorded. That verdict is not independently checkable from this repository. It was in any case a local-development review, not a release approval, and not evidence of real-world performance.
- **The frozen v2 protocol** is fully recorded in [`config/frozen_v2.json`](../config/frozen_v2.json) (config, protocol, seed mapping, source checksum and tuning log) and in [`results/v2/`](../results/v2/). The docstring of `beliefview/v2.py` still says "see DEMO_PASS_PLAN.md". It was left as is: `v2.py` is part of the checksummed frozen core, and editing even a comment would change the frozen source checksum.
- **Evaluation tools in `demo3d/tools/`** previously also hashed some of the omitted plan documents into their evidence snapshots. Those entries were removed from the file lists; the tools' runtime behaviour, gates and safety checks are unchanged. Snapshots recorded earlier by the private tool versions listed those plan files too, and will not be reproduced byte for byte by the public versions.
- **Raw evidence artifacts.** `ASTRA_SEARCH_STORY_REPORT.md` links raw run files (`demo3d/ml/results/search_story_*.json`, `demo3d/output/playwright/` screenshots) that are not part of this snapshot. Its figures are the author's record and are not re-checkable here.
- **Local baseline paths.** Several reports mention preservation baselines kept on the author's machine, a branch name, and a `demo3d/output/` directory. These are private and not published; they are described, not provided.

## Model provenance

The trained model's [`manifest.json`](../demo3d/public/models/beliefview3d-search-v1/manifest.json) is immutable provenance and was **not** modified. Its `source.repository` field records a **private** GitHub remote that existed when the model was built and remains in place (`generatorCommit` likewise refers to a commit in that private history, marked `+dirty`). That remote is not this repository and is not expected to resolve for you. As the manifest itself says, the exact-file `sourceSha256` values, not the commit, are the authoritative provenance, and they can be checked against the files published here.

## History and licence

This snapshot has its own new Git history, which does not contain the private history, so commit hashes quoted in retained documents refer to the private history, not to commits here. No licence has been chosen for this repository; until the owner adds one, no licence is granted.
