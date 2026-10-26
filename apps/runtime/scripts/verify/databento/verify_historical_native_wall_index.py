import argparse
import datetime as dt
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from threading import Thread
import time
import traceback
import io

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "conversion"))
from historical_l2_walls import manifest_parts, pinned_file

import duckdb


def hashed(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--qualified-root', required=True)
    parser.add_argument('--wall-root', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--candidate-root', required=True)
    parser.add_argument('--worker', required=True)
    args = parser.parse_args()
    started = time.monotonic()
    qualified, walls, out = map(Path, (args.qualified_root, args.wall_root, args.out))
    out.mkdir(mode=0o700)
    manifest_path = walls / 'index/manifest.json'
    manifest_sha = hashed(manifest_path)
    index = json.loads(manifest_path.read_bytes())
    index_parts = manifest_parts(index)
    candidate_root = Path(args.candidate_root)
    candidate = json.loads((candidate_root / 'candidate.json').read_bytes())
    if (hashed(candidate_root / 'candidate.json') != index['descriptor_sha256']
            or candidate['instrument_id'] != index['instrument_id']
            or candidate['derivation_id'] != index['derivation_id']):
        raise ValueError('published descriptor changed')
    receipt = {'source': str(candidate_root), 'date': candidate['date'], 'release_id': index['release_id'],
        'descriptor_sha256': index['descriptor_sha256'], 'manifest_sha256': index['event_manifest_sha256']}
    verify = qualified / 'src/apps/runtime/scripts/verify/databento'
    sys.path.insert(0, str(verify))
    import fetch_verified_part
    fetch_verified_part.DATA_ROOT = qualified / 'data'
    import fetch_verified_partition
    fetch_verified_partition.DATA_ROOT = qualified / 'data'
    is_cme = candidate['source']['method'] == 'native-cme-full-day-encoding/1'
    if not is_cme and candidate['source']['method'] != 'equity-first-depth-full-day-encoding/2':
        raise ValueError('unqualified native source method')
    import derive_historical_equity_core as equity
    import derive_historical_cme_core as cme
    from verify_historical_topn_partition import verified_files, ordered_depth_parts
    stem = Path(receipt['source']).name.removesuffix('-core')
    plans = [qualified / 'data' / (stem + '-' + family + '.json') for family in ('depth', 'trade')]
    if is_cme:
        raw_path = qualified / 'data' / (stem + '.dbn.zst')
        depth, depth_files, raw_hash = cme.admit_source(raw_path, plans[0], candidate['source']['depth'])
        if raw_hash != candidate['source']['rawSha256']:
            raise ValueError('native raw hash differs from published provenance')
        trade_files = []
    else:
        source_hashes = dict(candidate['source']['sourcePlans'])
        for plan in plans:
            if hashed(plan) != source_hashes[plan.name]:
                raise ValueError('native source plan differs from published provenance')
        depth, depth_files = verified_files(plans[0], 2 * 1024**3)
        trade, trade_files = verified_files(plans[1], 2 * 1024**3)
    config = json.loads((walls / 'config.json').read_text())
    config['profileId'] = index['profile_id']
    config['expectedSourceRows'] = depth['partition']['record_count']
    manifest_path = Path(receipt['source']) / 'events/manifest.json'
    if hashed(manifest_path) != receipt['manifest_sha256']:
        raise ValueError('published event manifest changed')
    manifest = json.loads(manifest_path.read_text())
    config['closeNs'] = manifest['parts'][-1]['last_known_ns']
    (out / 'config.json').write_text(json.dumps(config))
    dependencies = {str(Path(module.__file__)): hashed(module.__file__) for module in list(sys.modules.values())
        if getattr(module, '__file__', None) and Path(module.__file__).is_relative_to(qualified / 'src') and Path(module.__file__).is_file()}
    process = subprocess.Popen(['/opt/terminal-l1-l2/node-v24.21.0-linux-x64/bin/node', '--max-old-space-size=768',
        args.worker, str(out / 'config.json')], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=(out / 'node.stderr').open('wb'), env={key: value for key, value in os.environ.items() if key in ('PATH', 'LANG', 'TZ', 'HOME')})
    failures, sent, source_info = [], [0], {}
    def send():
        try:
            connection = duckdb.connect(config={'threads': '1', 'memory_limit': '512MB', 'temp_directory': str(out / 'duckdb-temp'),
                'max_temp_directory_size': '4GB', 'preserve_insertion_order': 'false'})
            try:
                if not is_cme:
                    parts = ordered_depth_parts(connection, depth, depth_files)
                    rank = equity.pinned_source_rank(connection, depth_files)
                    if 'sourceRank' in candidate['source'] and rank != candidate['source']['sourceRank']:
                        raise ValueError('native source rank changed')
                    source_info['source_rank'] = rank
                    connection.execute('CREATE TEMP TABLE trades AS SELECT record_id,event_ns,receive_ns,sequence,source_dataset,dbn_publisher_id,side,price,size FROM read_parquet(?)', [trade_files])
                    connection.execute('''CREATE TEMP TABLE anchors AS WITH first_depth AS (
                    SELECT event_ns,source_rank,stable_position,ordinal,receive_ns,sequence,source_dataset,dbn_publisher_id FROM read_parquet(?)
                    QUALIFY row_number() OVER (PARTITION BY source_dataset,dbn_publisher_id,sequence,event_ns,receive_ns ORDER BY source_rank,stable_position,ordinal)=1
                ) SELECT d.event_ns,d.source_rank,d.stable_position,d.ordinal,t.record_id,t.side,t.price,t.size
                  FROM first_depth d JOIN trades t ON t.event_ns=d.event_ns AND t.receive_ns=d.receive_ns AND t.sequence=d.sequence
                  AND t.source_dataset=d.source_dataset AND t.dbn_publisher_id=d.dbn_publisher_id''', [depth_files])
                    if connection.execute('SELECT count(*),count(DISTINCT record_id) FROM anchors').fetchone() != (trade['partition']['record_count'], trade['partition']['record_count']):
                        raise ValueError('native anchored trade count differs')
                start = int(dt.datetime.fromisoformat(receipt['date']).replace(tzinfo=dt.timezone.utc).timestamp()) * 1000000000
                batch = []
                rows = cme.normalized(cme.native_records(raw_path, receipt['date']), instrument=candidate['instrument_id'],
                    start=start, end=int(candidate['window_to_ns']), expected=config['expectedSourceRows'], raw_hash=raw_hash) if is_cme else equity.joined_rows(connection, parts, receipt['date'], start, config['expectedSourceRows'])
                for row in rows:
                    if time.monotonic() - started > 7200:
                        raise TimeoutError('native source walk deadline')
                    batch.append(row)
                    if len(batch) == 128:
                        process.stdin.write(json.dumps(batch, separators=(',', ':'), allow_nan=False).encode() + b'\n')
                        sent[0] += len(batch); batch = []
                        if sent[0] % 50000 < 128:
                            name = out / 'progress.json'
                            name.with_suffix('.tmp').write_text(json.dumps({'status': 'RUNNING', 'source_rows': sent[0], 'elapsed_seconds': time.monotonic() - started}))
                            name.with_suffix('.tmp').replace(name)
                if batch:
                    process.stdin.write(json.dumps(batch, separators=(',', ':'), allow_nan=False).encode() + b'\n'); sent[0] += len(batch)
                sources = [(depth, depth_files)] if is_cme else [(depth, depth_files), (trade, trade_files)]
                for plan, paths in sources:
                    if any(hashed(path) != part['sha256'] for path, part in zip(paths, plan['parts'])):
                        raise ValueError('native source part changed during walk')
                if is_cme and hashed(raw_path) != raw_hash:
                    raise ValueError('native raw source changed during walk')
                process.stdin.close()
            finally:
                connection.close()
        except BaseException as error:
            failures.append(str(error))
            (out / 'source-failure.json').write_text(json.dumps({'error': str(error), 'traceback': traceback.format_exc()}))
            process.kill()
    sender = Thread(target=send, daemon=True)
    sender.start()
    count, digest = 0, hashlib.sha256()
    fields = ('known_ns', 'walls', 'lifecycle', 'trades', 'wall_trades')
    try:
        def expected_samples():
            for part in index_parts:
                body = pinned_file(walls / 'index' / part['key'], part['bytes'], part['sha256'])
                with gzip.GzipFile(fileobj=io.BytesIO(body)) as compressed:
                    decoded = compressed.read(part['decoded_bytes'] + 1)
                if (len(decoded) != part['decoded_bytes'] or hashlib.sha256(decoded).hexdigest() != part['decoded_sha256']
                        or len(decoded.splitlines()) != part['rows']):
                    raise ValueError('index decoded bytes/counts differ')
                for line in decoded.splitlines():
                    row = json.loads(line)
                    if row['schema'] == 'historical-l2-wall-view/2':
                        yield {key: row[key] for key in fields}
                pinned_file(walls / 'index' / part['key'], part['bytes'], part['sha256'])
        expected = iter(expected_samples())
        for line in iter(lambda: process.stdout.readline(4 * 1024**2 + 1), b''):
            if len(line) > 4 * 1024**2 or not line.endswith(b'\n'):
                raise ValueError('native output row framing')
            actual = json.loads(line)
            if actual != next(expected, None):
                raise ValueError('native/index mismatch at sample ' + str(count))
            digest.update(json.dumps(actual, separators=(',', ':'), sort_keys=True, allow_nan=False).encode() + b'\n')
            count += 1
        if failures or next(expected, None) is not None:
            raise ValueError('native omitted indexed samples or source failed')
        sender.join(timeout=30)
        if sender.is_alive() or failures or process.wait(timeout=30) != 0 or sent[0] != config['expectedSourceRows'] or count != index['samples']:
            raise ValueError('native completion differs: ' + str(failures))
        if (hashed(walls / 'index/manifest.json') != manifest_sha
                or hashed(candidate_root / 'candidate.json') != index['descriptor_sha256']
                or any(hashed(path) != sha for path, sha in dependencies.items())):
            raise ValueError('projection or native source code changed')
        result = {'status': 'PASS', 'scope': 'all one-second walls, lifecycle, trades and wall-trades compared with a fresh native engine from qualified original depth/trade input; shared accepted trade-order generator; no wall-event projection used by reference',
            'source_rows': sent[0], 'source_parts': len(depth_files) + len(trade_files), 'samples_compared': count,
            'canonical_samples_sha256': digest.hexdigest(), 'index_manifest_sha256': manifest_sha,
            'release_id': receipt['release_id'], 'descriptor_sha256': receipt['descriptor_sha256'], 'elapsed_seconds': time.monotonic() - started,
            'source_code': dependencies, 'source_info': source_info, 'published': False, 'native': json.loads((out / 'node.stderr').read_text().strip())}
        with (out / 'result.json').open('x') as target:
            target.write(json.dumps(result)); target.flush(); os.fsync(target.fileno())
        print(json.dumps({key: value for key, value in result.items() if key != 'source_code'}))
    except BaseException as error:
        process.kill(); sender.join(timeout=15); process.wait(timeout=15)
        (out / 'failure.json').write_text(json.dumps({'status': 'FAILED', 'error': str(error), 'samples': count, 'source_rows': sent[0], 'elapsed_seconds': time.monotonic() - started}))
        raise


if __name__ == '__main__':
    main()
