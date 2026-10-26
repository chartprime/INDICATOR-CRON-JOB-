import argparse
import json
import os
from pathlib import Path

import boto3
from botocore.config import Config
import job
from s3_publish import Store, PublicationError, publish, _status


class InterruptingClient:
    def __init__(self, client):
        self.client = client
        self.fail_on = None

    def get_object(self, **kwargs):
        return self.client.get_object(**kwargs)

    def put_object(self, **kwargs):
        if self.fail_on and self.fail_on in kwargs["Key"]:
            raise RuntimeError("INJECTED_INTERRUPTION")
        return self.client.put_object(**kwargs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--bucket", required=True)
    ap.add_argument("--prefix", required=True)
    ap.add_argument("--node-bin", required=True)
    args = ap.parse_args()
    if not args.prefix.startswith("curated/_qualification/"):
        raise ValueError("QUALIFICATION_NAMESPACE_REQUIRED")
    root = Path(args.root)
    root.mkdir(parents=True, exist_ok=True)
    client = InterruptingClient(boto3.client("s3", region_name=os.environ["RCLONE_CONFIG_TTCONVERT_REGION"],
        aws_access_key_id=os.environ["RCLONE_CONFIG_TTCONVERT_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["RCLONE_CONFIG_TTCONVERT_SECRET_ACCESS_KEY"],
        config=Config(connect_timeout=10, read_timeout=60, retries={"max_attempts": 2})))
    store = Store(client, args.bucket, args.prefix)
    if store.get_json("_catalog/CURRENT.json")[0] is not None:
        raise ValueError("FRESH_NAMESPACE_REQUIRED")
    source = Path(__file__).resolve().parents[1] / "test/contracts/fixtures/market-observation-v1/databento-mbp1.dbn"
    inputs = [{"local_path": str(source), "schema": "mbp-1", "s3_key":
               "raw/databento/dataset=GLBX.MDP3/schema=mbp-1/symbol=ESH1/year=2020/month=12/day=28/x.dbn"}]
    def build(version):
        return job.run_job(inputs, version, staging_root=str(root / "stage"),
            curated_root=str(root / "curated"), catalog_root=str(root / "curated/_catalog"),
            node_bin=args.node_bin)["catalog_pointer"]
    checks = []
    first = build("qualification-a")
    client.fail_on = "CURRENT.json"
    try:
        publish(store, root / "curated", first, expected_parent=None)
        raise AssertionError("INTERRUPTION_NOT_OBSERVED")
    except RuntimeError as error:
        if str(error) != "INJECTED_INTERRUPTION":
            raise
    assert store.get_json("_catalog/CURRENT.json")[0] is None
    checks.append("interruption_before_pointer_invisible")
    client.fail_on = None
    publish(store, root / "curated", first, expected_parent=None)
    checks.append("retry_verified_objects_and_published")
    second = build("qualification-b")
    client.fail_on = "/receipts/"
    try:
        publish(store, root / "curated", second, expected_parent=first)
        raise AssertionError("INTERRUPTION_NOT_OBSERVED")
    except RuntimeError as error:
        if str(error) != "INJECTED_INTERRUPTION":
            raise
    assert store.get_json("_catalog/CURRENT.json")[0] == second
    client.fail_on = None
    publish(store, root / "curated", second, expected_parent=first)
    checks.append("interruption_after_pointer_receipt_recovered")
    assert publish(store, root / "curated", first, expected_parent=None)["status"] == "ALREADY_PUBLISHED"
    assert store.get_json("_catalog/CURRENT.json")[0] == second
    checks.append("old_retry_did_not_rollback")
    _, etag = store.get_json("_catalog/CURRENT.json")
    try:
        client.put_object(Bucket=args.bucket, Key=store.key("_catalog/CURRENT.json"),
                          Body=b"{}", ContentLength=2, IfMatch='"stale-etag"')
        raise AssertionError("STALE_ETAG_ACCEPTED")
    except Exception as error:
        if _status(error) != 412:
            raise
    assert store.get_json("_catalog/CURRENT.json")[1] == etag
    checks.append("real_s3_stale_etag_rejected_412")
    result = {"status": "PASS", "checks": checks, "prefix": args.prefix,
              "verified_read_bytes": store.read_bytes, "uploaded_bytes": store.write_bytes,
              "scope": "small real fixture; injected client interruptions; no raw writes or deletion"}
    (root / "report.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
