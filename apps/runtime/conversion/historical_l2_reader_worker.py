"""Use the archive's bounded frame protocol and process cancellation for L2 pages."""

from __future__ import annotations

from contextlib import contextmanager
import os
import sys

from archive_reader import connect
from archive_reader_worker import read_frame, write_reply
from historical_l2_reader import read_page


def main():
    connection = connect(memory_bytes=128 * 1024**2, temp_bytes=256 * 1024**2,
                         temp_dir=os.environ.get("TT_READER_TEMP_DIR"))
    try:
        while True:
            request = read_frame(sys.stdin.buffer)
            if request is None:
                break
            @contextmanager
            def resolve(part):
                yield request["paths"][part["name"]]

            try:
                if request["family"] in ("walls", "prints"):
                    if request["family"] == "walls":
                        from historical_l2_walls import read_page as wall_page
                    else:
                        from historical_l2_prints import read_page as wall_page
                    result = wall_page(request["manifest"], request["paths"],
                                       from_ns=request["from"], to_ns=request["to"], as_of_key=request["asOfKey"],
                                       limit=request["limit"], after_position=request.get("afterPosition"),
                                       max_scan_bytes=request["maxScanBytes"])
                else:
                    result = read_page(connection, request["manifest"], request["family"], resolve,
                                   from_ns=request["from"], to_ns=request["to"], as_of_key=request["asOfKey"],
                                   limit=request["limit"], after_position=request.get("afterPosition"),
                                   max_scan_bytes=request["maxScanBytes"])
            except Exception as error:
                write_reply(sys.stdout.buffer, {"error": "PARTITION_VERIFICATION_FAILED",
                                                "detail": {"reason": str(error)[:256]}})
            else:
                write_reply(sys.stdout.buffer, {"ok": result})
    finally:
        connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
