"""Loopback-only service for the separately published historical L2 contract."""

import argparse
import json
import os
import sys

from archive_cache import PartCache
from archive_http import _build_query_s3_client, serve
from historical_l2_catalog import PREFIX
from historical_l2_service import Service
from s3_publish import Store


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--cache-root", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8004)
    parser.add_argument("--wall-index-root")
    parser.add_argument("--wall-index-registry")
    parser.add_argument("--print-index-root")
    parser.add_argument("--print-index-registry")
    parser.add_argument("--min-free-disk-bytes", type=int, default=40 * 1024**3)
    args = parser.parse_args(argv)
    secret = os.environ.get("TT_QUERY_SERVICE_SECRET")
    if not secret:
        print(json.dumps({"event": "historical_l2_http_refused", "reason": "SERVICE_SECRET_NOT_CONFIGURED"}),
              file=sys.stderr, flush=True)
        return 2
    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        parser.error("loopback bind required")
    registry = None
    if bool(args.wall_index_root) != bool(args.wall_index_registry):
        parser.error("wall index root and registry must be configured together")
    if args.wall_index_root:
        from pathlib import Path
        from historical_l2_walls import Registry
        path = Path(args.wall_index_registry)
        if path.is_symlink() or path.stat().st_size > 65_536:
            parser.error("wall registry exceeds admission")
        registry = Registry(args.wall_index_root, json.loads(path.read_bytes()))
    print_registry = None
    if bool(args.print_index_root) != bool(args.print_index_registry):
        parser.error("print index root and registry must be configured together")
    if args.print_index_root:
        from pathlib import Path
        from historical_l2_prints import Registry as PrintRegistry
        path = Path(args.print_index_registry)
        if path.is_symlink() or path.stat().st_size > 65_536:
            parser.error("print registry exceeds admission")
        print_registry = PrintRegistry(args.print_index_root, json.loads(path.read_bytes()))
    service = Service(Store(_build_query_s3_client(), args.bucket, PREFIX),
                      PartCache(args.cache_root, min_free_disk_bytes=args.min_free_disk_bytes), service_secret=secret,
                      wall_registry=registry, print_registry=print_registry)
    server = None
    try:
        server = serve(service, host=args.host, port=args.port)
        print(json.dumps({"event": "historical_l2_http_listening", "port": server.server_address[1]}),
              file=sys.stderr, flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if server is not None:
            server.server_close()
        service.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
