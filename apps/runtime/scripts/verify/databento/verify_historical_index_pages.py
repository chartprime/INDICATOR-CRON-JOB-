"""Compare captured gateway pages with independent, complete sealed-index reads."""

import argparse
import gzip
import hashlib
import json
from pathlib import Path


def verify(root, capture):
    results = []
    selected = [case for case in capture["captures"] if case["query"]["family"] in ("walls", "prints")]
    if len(selected) != 8:
        raise ValueError("four instruments and two indexed families required")
    for case in selected:
        query = case["query"]
        family, instrument = query["family"], query["instrumentId"]
        directory = root / ("served-walls" if family == "walls" else "served-prints") / hashlib.sha256(instrument.encode()).hexdigest() / query["date"]
        manifest = json.loads((directory / "manifest.json").read_bytes())
        if manifest["instrument_id"] != instrument or manifest["release_id"] != capture["catalog"]["releaseId"]:
            raise ValueError("independent index identity differs")
        actual = [row for page in case["pages"] for row in page["rows"]]
        expected = []
        cut = tuple(map(int, query["asOfKey"]))
        position = 0
        for part in manifest["parts"]:
            body = (directory / part["key"]).read_bytes()
            if len(body) != part["bytes"] or hashlib.sha256(body).hexdigest() != part["sha256"]:
                raise ValueError("independent encoded part differs")
            raw = gzip.decompress(body)
            if len(raw) != part["decoded_bytes"] or hashlib.sha256(raw).hexdigest() != part["decoded_sha256"]:
                raise ValueError("independent decoded part differs")
            lines = raw.splitlines()
            if len(lines) != part["rows"]:
                raise ValueError("independent row count differs")
            for line in lines:
                payload = json.loads(line)
                known = int(payload["known_ns"])
                key = payload.get("through_known_key") if family == "walls" else payload["known_key"]
                if int(query["from"]) <= known < int(query["to"]) and known <= cut[0] and (key is None or tuple(map(int, key)) <= cut):
                    expected.append({"schema": f"historical-l2-{'wall' if family == 'walls' else 'print'}-record/1",
                                     "instrument_id": instrument, "derivation_id": manifest["derivation_id"],
                                     "append_position": str(position), "known_ns": str(known), "known_key": key,
                                     "payload": payload, "record_id": hashlib.sha256(line).hexdigest()})
                position += 1
        if position != manifest["rows"] or actual != expected:
            raise ValueError(f"independent complete reference differs for {instrument}/{family}")
        results.append({"instrument": instrument, "family": family, "rows": len(expected), "pages": len(case["pages"]),
                        "manifest_sha256": hashlib.sha256((directory / "manifest.json").read_bytes()).hexdigest(),
                        "reference_sha256": hashlib.sha256(json.dumps(expected, sort_keys=True, separators=(",", ":")).encode()).hexdigest()})
    return {"status": "PASS", "release_id": capture["catalog"]["releaseId"], "cases": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--capture", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.capture.stat().st_size > 200 * 1024**2:
        raise ValueError("capture exceeds qualification budget")
    result = verify(args.root, json.loads(args.capture.read_bytes()))
    with args.out.open("x", encoding="utf8") as target:
        json.dump(result, target, indent=2)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
