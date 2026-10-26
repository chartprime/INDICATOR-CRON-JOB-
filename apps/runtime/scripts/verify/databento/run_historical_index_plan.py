"""Resume bounded local index qualification; never publishes or activates serving."""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
from threading import Event, Lock
import time

from prepare_historical_index_plan import hashed, load_job


def bounded_command(command, *, stdout, stderr, env, stop, timeout):
    process = subprocess.Popen(command, stdout=stdout, stderr=stderr, env=env, start_new_session=os.name != "nt")
    deadline = time.monotonic() + timeout
    try:
        while process.poll() is None:
            if stop.wait(0.25):
                raise InterruptedError("index run stopped")
            if time.monotonic() >= deadline:
                raise TimeoutError("index phase deadline exceeded")
        if process.returncode != 0:
            raise subprocess.CalledProcessError(process.returncode, command)
    finally:
        if os.name != "nt":
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        elif process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            if os.name != "nt":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            else:
                process.kill()
            process.wait(timeout=10)
        finally:
            if os.name != "nt":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


def atomic(path, value):
    temporary = path.with_suffix(".pending")
    with temporary.open("w") as stream:
        json.dump(value, stream, separators=(",", ":"), allow_nan=False)
        stream.flush(); os.fsync(stream.fileno())
    temporary.replace(path)
    if os.name != "nt":
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def check_index(directory, family, plan, job):
    from historical_l2_walls import manifest_parts as wall_parts, pinned_file
    from historical_l2_prints import manifest_parts as print_parts
    body = (directory / "manifest.json").read_bytes()
    manifest = json.loads(body)
    if (manifest["release_id"] != plan["pointer"]["release_id"]
            or manifest["descriptor_sha256"] != job["descriptor_sha256"]
            or manifest["instrument_id"] != job["instrument_id"]):
        raise ValueError("completed index differs from pinned job")
    for part in (wall_parts if family == "walls" else print_parts)(manifest):
        pinned_file(directory / part["key"], part["bytes"], part["sha256"])
    return {"manifest_bytes": len(body), "manifest_sha256": hashlib.sha256(body).hexdigest()}


def check_receipt(result, plan, job):
    if result.get("status") != "PASS":
        raise ValueError("qualified receipt is not complete")
    if hashed(result["native_receipt"]) != result["native_receipt_sha256"]:
        raise ValueError("resumed native receipt differs")
    native = json.loads(Path(result["native_receipt"]).read_bytes())
    if (native.get("status") != "PASS"
            or native.get("release_id") != plan["pointer"]["release_id"]
            or native.get("descriptor_sha256") != job["descriptor_sha256"]):
        raise ValueError("native proof differs from pinned job")
    for family in ("walls", "prints"):
        if check_index(Path(result[family]["directory"]), family, plan, job) != result[family]["identity"]:
            raise ValueError("resumed completed bytes differ")
    if result["walls"]["identity"]["manifest_sha256"] != native.get("index_manifest_sha256"):
        raise ValueError("native proof belongs to another index")


def run(args):
    plan = json.loads(Path(args.plan).read_bytes())
    if hashed(args.plan) != args.plan_sha256:
        raise ValueError("frozen month plan differs")
    root = Path(args.out).resolve()
    root.mkdir(mode=0o700, exist_ok=True)
    marker = root / "plan.sha256"
    if marker.exists() and marker.read_text() != args.plan_sha256:
        raise ValueError("resume root belongs to another plan")
    if not marker.exists():
        with marker.open("x") as stream:
            stream.write(args.plan_sha256); stream.flush(); os.fsync(stream.fileno())
    stop, lock = Event(), Lock()
    for name in (signal.SIGTERM, signal.SIGINT):
        signal.signal(name, lambda _signum, _frame: stop.set())
    states = {job["instrument_id"] + "/" + job["date"]: {"status": "PENDING"} for job in plan["jobs"]}
    started = time.monotonic()
    script = Path(__file__).parent
    clean = {key: value for key, value in os.environ.items() if key in ("PATH", "LANG", "TZ", "HOME")}

    def progress(key, state):
        with lock:
            states[key] = state
            atomic(root / "status.json", {"schema": "historical-l2-index-run/1", "plan_sha256": args.plan_sha256,
                "release_id": plan["pointer"]["release_id"], "lanes": args.lanes,
                "elapsed_seconds": time.monotonic() - started,
                "counts": {value: sum(item["status"] == value for item in states.values())
                           for value in ("PENDING", "RUNNING", "PASS", "FAILED", "STOPPED")}, "jobs": states})

    def qualify(job):
        key = job["instrument_id"] + "/" + job["date"]
        if stop.is_set():
            progress(key, {"status": "STOPPED"}); return
        dayroot = root / hashlib.sha256(job["instrument_id"].encode()).hexdigest() / job["date"]
        try:
            pinned, _job, _descriptor = load_job(args.plan, args.plan_sha256, job["instrument_id"], job["date"])
            dayroot.mkdir(parents=True, mode=0o700, exist_ok=True)
            if dayroot.is_symlink():
                raise ValueError("resume directory symlink refused")
            if shutil.disk_usage(root).free < 40 * 1024**3:
                raise ValueError("40 GiB host disk reserve required")
            receipt = dayroot / "qualified.json"
            if receipt.exists():
                result = json.loads(receipt.read_bytes())
                check_receipt(result, pinned, job)
                progress(key, result); return
            attempt = 1
            while (dayroot / f"attempt-{attempt:04d}").exists():
                attempt += 1
                if attempt > 100:
                    raise ValueError("attempt limit exceeded")
            work = dayroot / f"attempt-{attempt:04d}"
            work.mkdir(mode=0o700)
            progress(key, {"status": "RUNNING", "attempt": str(work), "phase": "walls"})

            def command(name, arguments, timeout=7500):
                with (work / (name + ".stdout")).open("wb") as stdout, (work / (name + ".stderr")).open("wb") as stderr:
                    bounded_command([args.python, str(script / (name + ".py")), *arguments],
                        stdout=stdout, stderr=stderr, env=clean, stop=stop, timeout=timeout)

            command("derive_historical_wall_index", ["--plan", args.plan, "--plan-sha256", args.plan_sha256,
                "--instrument", job["instrument_id"], "--date", job["date"], "--out", str(work / "walls"),
                "--node", args.node, "--worker", args.wall_worker])
            progress(key, {"status": "RUNNING", "attempt": str(work), "phase": "native comparison"})
            command("verify_historical_native_wall_index", ["--qualified-root", plan["qualified_root"],
                "--candidate-root", job["candidate_root"], "--wall-root", str(work / "walls"),
                "--out", str(work / "native"), "--worker", args.native_worker])
            native = json.loads((work / "native/result.json").read_bytes())
            if native["status"] != "PASS":
                raise ValueError("independent native comparison failed")
            progress(key, {"status": "RUNNING", "attempt": str(work), "phase": "individual prints"})
            command("derive_historical_print_index", ["--qualified-root", plan["qualified_root"],
                "--candidate-root", job["candidate_root"], "--release-id", plan["pointer"]["release_id"],
                "--descriptor-sha256", job["descriptor_sha256"], "--out", str(work / "prints")])
            result = {"status": "PASS", "attempt": str(work), "native_receipt": str(work / "native/result.json"),
                "native_receipt_sha256": hashed(work / "native/result.json")}
            for family, directory in (("walls", work / "walls/index"), ("prints", work / "prints")):
                result[family] = {"directory": str(directory), "identity": check_index(directory, family, pinned, job)}
            check_receipt(result, pinned, job)
            atomic(receipt, result)
            progress(key, result)
        except Exception as error:
            progress(key, {"status": "STOPPED" if isinstance(error, InterruptedError) else "FAILED",
                "reason": type(error).__name__, "evidence": str(dayroot)})

    with ThreadPoolExecutor(max_workers=args.lanes) as pool:
        futures = [pool.submit(qualify, job) for job in plan["jobs"]]
        for future in as_completed(futures):
            future.result()
    if any(state["status"] != "PASS" for state in states.values()):
        raise ValueError("month incomplete; inspect status.json and retained attempt logs")
    for family in ("walls", "prints"):
        destination = root / ("served-" + family)
        destination.mkdir(mode=0o700, exist_ok=True)
        entries = []
        for job in plan["jobs"]:
            result = states[job["instrument_id"] + "/" + job["date"]]
            source = Path(result[family]["directory"])
            target = destination / hashlib.sha256(job["instrument_id"].encode()).hexdigest() / job["date"]
            target.parent.mkdir(mode=0o700, exist_ok=True)
            if not target.exists():
                shutil.copytree(source, target)
            identity = check_index(target, family, plan, job)
            if identity != result[family]["identity"]:
                raise ValueError("served copy differs")
            entries.append({"instrument_id": job["instrument_id"], "date": job["date"], **identity})
        atomic(root / (family + "-registry.json"), entries)
    atomic(root / "complete.json", {"status": "LOCAL_VERIFIED", "jobs": len(plan["jobs"]),
        "plan_sha256": args.plan_sha256, "release_id": plan["pointer"]["release_id"], "published": False})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("plan", "plan-sha256", "out", "python", "node", "wall-worker", "native-worker"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--lanes", type=int, default=4, choices=range(1, 5))
    args = parser.parse_args()
    if os.name != "posix":
        raise ValueError("month qualification runner requires the Linux host")
    import fcntl
    root = Path(args.out).resolve()
    root.mkdir(mode=0o700, exist_ok=True)
    with (root / "run.lock").open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        run(args)


if __name__ == "__main__":
    main()
