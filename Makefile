PY := .venv/bin/python

.PHONY: setup test all results tune demo v2-tune v2-final v2-repro-check v2-report v1-repro v1-tune-repro

setup:
	python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

test:
	$(PY) -m pytest -q

# THE one command: tests, then rebuild the v2 tables, figures, animations, log and demo from the
# SAVED v2 records. It runs no inferential episode (the v2 final run happens once; see v2-final).
all: test v2-report

# ---- v2 (headline) -----------------------------------------------------------------------
# validation tuning on split id 3, then freezes config/frozen_v2.json; refuses if already frozen
v2-tune:
	$(PY) -m beliefview.cli v2-tune

# the ONE final run on split id 4 with the frozen v2 config; refuses to run a second time
v2-final:
	$(PY) -m beliefview.cli v2-final

# deliberate, labelled reproducibility check: reruns into results/v2/repro_check/ and compares records
v2-repro-check:
	$(PY) -m beliefview.cli v2-final --repro-check

v2-report:
	$(PY) -m beliefview.cli v2-report

demo:
	$(PY) -m beliefview.cli demo

# the old target names now point at v2 and cannot overwrite anything inferential
tune: v2-tune
results: v2-report

# ---- v1 (earlier record; reproduction only) ----------------------------------------------
# reruns the v1 frozen config on the v1 test split into results/v1_repro/ (never the v1 record)
v1-repro:
	$(PY) -m beliefview.cli test

v1-tune-repro:
	$(PY) -m beliefview.cli tune
