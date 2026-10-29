"""Run one analysis job in a fresh, resource-limited subprocess.

Limits: CPU seconds, address space, processes, file size and open files (setrlimit), a
wall-clock timeout, an empty environment, a throwaway working directory, isolated Python
(-I). In production this runs inside the `pyrunner` container, which additionally has no
network, a read-only filesystem, no secrets and no capabilities; those container settings
are the real boundary, these limits make failures fast and clean."""

from __future__ import annotations

import json
import os
import resource
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class RunnerLimits(BaseSettings):
    """The runner's own settings (a separate service; it never reads core.settings)."""

    model_config = SettingsConfigDict(env_prefix="PYRUNNER_", env_ignore_empty=True, extra="ignore")
    cpu_s: int = 15
    mem_mb: int = 1024
    wall_s: float = 25
    nproc: int = 64


LIMITS = {**RunnerLimits().model_dump(), "max_input_mb": 40}
BOOT = Path(__file__).with_name("bootstrap.py")

# Job processes still running, by pid. Anything else descending from this process after a
# job ends is left over from a finished job and gets killed (see sweep).
_active: set[int] = set()
_active_lock = threading.Lock()
_reaper = False


def become_reaper() -> None:
    """Adopt every orphan of a job (PR_SET_CHILD_SUBREAPER), so a process a job forked and
    left behind cannot outlive it unnoticed. Called once by the pyrunner server."""
    global _reaper
    import ctypes

    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_CHILD_SUBREAPER) failed")
    _reaper = True


def _parents() -> dict[int, tuple[int, str]]:
    procs = {}
    for entry in os.scandir("/proc"):
        if not entry.name.isdigit():
            continue
        try:
            stat = Path(entry.path, "stat").read_text()
        except OSError:
            continue
        fields = stat[stat.rindex(")") + 2:].split()
        procs[int(entry.name)] = (int(fields[1]), fields[0])  # ppid, state
    return procs


def sweep() -> None:
    """Kill and reap every descendant of this process that does not belong to a running job."""
    if not _reaper:
        return
    me = os.getpid()
    procs = _parents()
    with _active_lock:
        active = set(_active)

    def stale(pid: int) -> bool:
        while pid in procs and pid != me:
            if pid in active:
                return False
            pid = procs[pid][0]
        return pid == me

    for pid, (ppid, state) in procs.items():
        if pid == me or not stale(pid):
            continue
        if state != "Z":
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if ppid == me:
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass


def _limit():  # runs in the child between fork and exec
    mem = LIMITS["mem_mb"] * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_CPU, (LIMITS["cpu_s"], LIMITS["cpu_s"]))
    resource.setrlimit(resource.RLIMIT_AS, (mem, mem))
    resource.setrlimit(resource.RLIMIT_FSIZE, (20 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    try:
        resource.setrlimit(resource.RLIMIT_NPROC, (LIMITS["nproc"], LIMITS["nproc"]))
    except (ValueError, OSError):
        pass
    os.setsid()


def run_job(code: str, data: dict) -> dict:
    payload = json.dumps({"code": code, "data": data}, default=str)
    if len(payload) > LIMITS["max_input_mb"] * 1024 * 1024:
        return {"status": "rejected", "error": "dataset too large for one analysis job", "duration_s": 0}
    t0 = time.time()
    with tempfile.TemporaryDirectory(prefix="analysis-") as tmp:
        p = subprocess.Popen([sys.executable, "-I", str(BOOT)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, cwd=tmp,
                             env={"PATH": "/usr/bin:/bin", "HOME": tmp, "MPLCONFIGDIR": tmp,
                                  "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"},
                             preexec_fn=_limit)
        with _active_lock:
            _active.add(p.pid)
        try:
            stdout, stderr = p.communicate(payload, timeout=LIMITS["wall_s"])
        except subprocess.TimeoutExpired:
            return {"status": "timeout", "error": f"stopped after {LIMITS['wall_s']:.0f} s (time limit)",
                    "duration_s": round(time.time() - t0, 2)}
        finally:
            # The job's whole session goes, finished or not: nothing it started may linger.
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            p.wait()
            with _active_lock:
                _active.discard(p.pid)
            sweep()
    dur = round(time.time() - t0, 2)
    if p.returncode != 0 or not stdout.strip():
        why = "killed (CPU or memory limit)" if p.returncode and p.returncode < 0 else (stderr[-1500:] or "no output")
        return {"status": "failed", "error": why, "duration_s": dur}
    try:
        out = json.loads(stdout)
    except ValueError:
        return {"status": "failed", "error": "sandbox returned malformed output", "duration_s": dur}
    out["status"] = "error" if out.get("error") else "ok"
    out["duration_s"] = dur
    return out
