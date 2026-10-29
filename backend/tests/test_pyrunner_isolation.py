"""A job must not leave processes behind that could watch later jobs (other users' data)."""

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(not sys.platform.startswith("linux"), reason="prctl and /proc are Linux-only")

BACKEND = Path(__file__).resolve().parents[1]
# RLIMIT_NPROC counts every process of the user; a developer machine already has more than
# the container's 64, so fork would fail with EAGAIN before the test gets going.
ENV = {**os.environ, "PYRUNNER_NPROC": "100000"}

# The audit hook is not a boundary: user code can switch it off and fork a child that
# detaches into its own session, outliving the job. The runner must still kill it.
LINGER = textwrap.dedent("""
    import os, sys, time
    m = sys.modules["__main__"]
    m.BLOCK = ("never",)
    m.TMP = "/"
    if os.fork() == 0:
        os.setsid()
        os.closerange(0, 3)  # release the job's pipes so the job itself ends normally
        if os.fork() == 0:
            time.sleep(60)
        os._exit(0)
    print("forked")
""")

SCRIPT = textwrap.dedent("""
    import json, os, sys, time
    from pyrunner import execute
    execute.become_reaper()
    out = execute.run_job(sys.argv[1], {})
    time.sleep(0.2)
    left = [p for p, (ppid, state) in execute._parents().items() if p != os.getpid() and state != "Z"
            and ppid == os.getpid()]
    print(json.dumps({"status": out["status"], "left": left}))
""")


def test_processes_a_job_leaves_behind_are_killed():
    r = subprocess.run([sys.executable, "-c", SCRIPT, LINGER], cwd=BACKEND, env=ENV, capture_output=True, text=True,
                       timeout=60)
    assert r.returncode == 0, r.stderr
    result = json.loads(r.stdout.strip().splitlines()[-1])
    assert result["status"] == "ok"
    assert result["left"] == []


DUMPABLE = textwrap.dedent("""
    import ctypes, sys
    sys.modules["__main__"].BLOCK = ("never",)
    print("dumpable=%d" % ctypes.CDLL(None).prctl(3, 0, 0, 0, 0))  # PR_GET_DUMPABLE
""")


def test_job_processes_are_not_dumpable():
    r = subprocess.run([sys.executable, "-c",
                        "import json, sys; from pyrunner.execute import run_job; "
                        "print(json.dumps(run_job(sys.argv[1], {})))", DUMPABLE],
                       cwd=BACKEND, env=ENV, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout.strip().splitlines()[-1])
    assert out["status"] == "ok", out
    assert "dumpable=0" in out["stdout"]
