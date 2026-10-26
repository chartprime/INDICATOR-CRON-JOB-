"""Copy a curated part or explicitly admitted CME/Nasdaq raw DBN into ignored pilot data.

The source host and Space are read-only. The local output is admitted only if
its exact byte count and SHA-256 match the supplied pinned source identity.
Raw DBN hashes must come from verified canonical lineage, not an S3 ETag.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


DATA_ROOT = Path(__file__).resolve().parents[3] / "data" / "historical-l2-pilot"
REMOTE_ROOT = "ttconvert:chartprime-historical-data/"
MAX_PART_BYTES = 64 * 1024 * 1024
MAX_DBN_BYTES = 1024 * 1024 * 1024


def fetch(*, host: str, relative_key: str, expected_sha256: str, expected_bytes: int, output: Path) -> None:
    _fetch(host=host, relative_key=relative_key, expected_sha256=expected_sha256,
           expected_bytes=expected_bytes, output=output, raw_dbn=False)


def fetch_dbn(*, host: str, relative_key: str, expected_sha256: str, expected_bytes: int, output: Path) -> None:
    _fetch(host=host, relative_key=relative_key, expected_sha256=expected_sha256,
           expected_bytes=expected_bytes, output=output, raw_dbn=True)


def _fetch(*, host: str, relative_key: str, expected_sha256: str, expected_bytes: int,
           output: Path, raw_dbn: bool) -> None:
    if not re.fullmatch(r"[a-z][a-z0-9_-]*@[A-Za-z0-9.-]+", host):
        raise ValueError("invalid SSH host")
    prefixes = ("raw/databento/dataset=GLBX.MDP3/schema=mbp-10/",
                "raw/databento/dataset=XNAS.ITCH/schema=mbp-10/") if raw_dbn else ("curated/databento/databento/",)
    suffix = ".dbn.zst" if raw_dbn else ".parquet"
    if (not relative_key.startswith(prefixes)
            or not re.fullmatch(r"[A-Za-z0-9/_=.-]+", relative_key)
            or any(part in ("", ".", "..") for part in relative_key.split("/"))
            or not relative_key.endswith(suffix)):
        raise ValueError("invalid raw DBN key" if raw_dbn else "invalid curated part key")
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ValueError("invalid expected SHA-256")
    maximum = MAX_DBN_BYTES if raw_dbn else MAX_PART_BYTES
    if type(expected_bytes) is not int or not 1 <= expected_bytes <= maximum:
        raise ValueError("invalid expected byte count")
    destination = output.resolve()
    if not destination.is_relative_to(DATA_ROOT.resolve()) or not destination.name.endswith(suffix):
        raise ValueError("output must have the matching format under ignored historical-l2-pilot data")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if destination.stat().st_size == expected_bytes:
            with destination.open("rb") as source:
                if hashlib.file_digest(source, "sha256").hexdigest() == expected_sha256:
                    return
        raise FileExistsError("an existing pilot file has a different identity")
    if shutil.disk_usage(destination.parent).free < expected_bytes + MAX_PART_BYTES:
        raise RuntimeError("insufficient free disk for the admitted file plus reserve")

    appdata = os.environ.get("LOCALAPPDATA")
    if not appdata:
        raise RuntimeError("LOCALAPPDATA is required for the provisioned SSH key")
    private_key = Path(appdata) / "Terminal-L1-L2" / "ssh-bootstrap" / "id_ed25519"
    if not private_key.is_file():
        raise RuntimeError("provisioned SSH key is unavailable")
    remote_script = ("set -a\n. /etc/terminal-l1-l2/convert/service.env\nset +a\n"
                     f"rclone cat {REMOTE_ROOT}{relative_key} 2>/dev/null\n")
    encoded = base64.b64encode(remote_script.encode()).decode("ascii")
    command = ["ssh", "-i", str(private_key), "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
               "-o", "HostKeyAlgorithms=ssh-ed25519", "-o", "StrictHostKeyChecking=yes",
               "-o", "ConnectTimeout=15", host,
               f"printf %s {encoded} | base64 -d | sudo -n bash"]
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, suffix=".part", delete=False) as sink:
            temporary = Path(sink.name)
            digest = hashlib.sha256()
            count = 0
            with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
                assert process.stdout is not None
                while chunk := process.stdout.read(1024 * 1024):
                    count += len(chunk)
                    if count > expected_bytes:
                        process.kill()
                        raise RuntimeError("source exceeds manifest byte count")
                    digest.update(chunk)
                    sink.write(chunk)
                if process.wait() != 0:
                    raise RuntimeError("source read failed")
        if count != expected_bytes or digest.hexdigest() != expected_sha256:
            raise RuntimeError("source identity differs from authenticated manifest")
        temporary.replace(destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--relative-key", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--bytes", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--raw-dbn", action="store_true")
    options = parser.parse_args()
    reader = fetch_dbn if options.raw_dbn else fetch
    reader(host=options.host, relative_key=options.relative_key, expected_sha256=options.sha256,
           expected_bytes=options.bytes, output=options.output)
    print("verified pilot part copied")
