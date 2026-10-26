"""Owned, isolated production-storage fixture contention test. No provider access."""
import concurrent.futures
import json
import shutil
import statistics
import subprocess
import sys
import time
import uuid
from pathlib import Path

import duckdb
import psutil
from convert import HERE, REPO, digest


def main():
    fixture = Path(sys.argv[1]).resolve()
    report = json.loads((fixture / 'report.json').read_text())
    root = fixture.parent / ('mixed-' + uuid.uuid4().hex[:8])
    root.mkdir()
    node = shutil.which('node')
    if not node:
        raise RuntimeError('NODE_REQUIRED')
    commands = {
        'binance': [node, str(REPO/'apps/runtime/scripts/qualify/qualify-collector-storage.js'), '--events-per-tuple', '50000' if '--stress' in sys.argv else '20000', '--depth-events', '10000' if '--stress' in sys.argv else '2000', '--keep-synthetic-db'],
        'dxfeed': [node, str(REPO/'apps/runtime/scripts/qualify/qualify-dxfeed-storage.js'), '--events-per-instrument', '10000', '--keep-synthetic-db'],
        'conversion': [sys.executable, str(HERE/'convert.py'), str(fixture.parent/'samples/aapl-mbp10.dbn.zst'), str(root/'converted'), '--kind', 'databento-mbp', '--max-rows', '10000'],
    }
    children = {}
    streams = []
    started = time.perf_counter()
    deadline = started + 120
    peaks = []

    def reader(index):
        kind = 'trade' if index % 2 == 0 else 'depth'
        r = report['runs'][index % 2]
        seek = (int(r['minimumNs'])+int(r['maximumNs']))//2
        conn = duckdb.connect(config={'memory_limit': '64MB', 'threads': 1})
        measurements = []
        try:
            while time.perf_counter() < started + 30:
                begin = time.perf_counter()
                result = conn.execute('SELECT * FROM read_parquet(?) WHERE event_ns >= ? ORDER BY event_ns,position LIMIT 1000', [str(fixture/(kind+'.parquet')), seek]).fetchall()
                if len(result) != 1000:
                    raise RuntimeError('QUERY_ROW_COUNT')
                measurements.append((time.perf_counter()-begin)*1000)
            return measurements
        finally:
            conn.close()

    try:
        for name, command in commands.items():
            out = (root/(name+'.stdout.json')).open('wb')
            err = (root/(name+'.stderr.txt')).open('wb')
            streams.extend([out, err])
            children[name] = subprocess.Popen(command, stdout=out, stderr=err, cwd=REPO)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            readers = [pool.submit(reader, i) for i in range(8)]
            while any(p.poll() is None for p in children.values()) or not all(f.done() for f in readers):
                if time.perf_counter() > deadline:
                    raise RuntimeError('MIXED_LOAD_DEADLINE')
                rss = psutil.Process().memory_info().rss
                for child in children.values():
                    try:
                        owned = psutil.Process(child.pid)
                        rss += sum(p.memory_info().rss for p in [owned]+owned.children(recursive=True))
                    except psutil.NoSuchProcess:
                        pass
                peaks.append(rss)
                time.sleep(.05)
            times = [x for f in readers for x in f.result()]
        for stream in streams:
            stream.close()
        results = {}
        for name, child in children.items():
            try:
                result = json.loads((root/(name+'.stdout.json')).read_text())
            except json.JSONDecodeError:
                result = None
            results[name] = {'exitCode': child.returncode, 'result': result,
                             'stderr': (root/(name+'.stderr.txt')).read_text()[-4000:]}
        result = {'scope': '30s eight local query clients + production storage synthetic fixtures + 10k canonical conversion',
                  'notQualified': ['provider network/reconnect', 'replay state/indicators', 'cold S3 seek', 'all-market peak'],
                  'scriptSha256': digest(__file__), 'fixtureReportSha256': digest(fixture/'report.json'),
                  'stress': '--stress' in sys.argv, 'commands': commands,
                  'queries': len(times), 'medianMs': statistics.median(times),
                  'p95Ms': sorted(times)[int(len(times)*.95)-1], 'maximumMs': max(times),
                  'sampledOwnedProcessTreePeakRssBytes': max(peaks), 'sampleIntervalMs': 50,
                  'elapsedSeconds': time.perf_counter()-started, 'jobs': results}
        result['passed'] = all(job['exitCode'] == 0 for job in results.values())
        (root/'report.json').write_text(json.dumps(result, indent=2)+'\n')
        print(str(root/'report.json'))
        print(json.dumps({k:v for k,v in result.items() if k != 'jobs'}))
        if not result['passed']:
            raise SystemExit(1)
    finally:
        for child in children.values():
            if child.poll() is None:
                owned = psutil.Process(child.pid)
                for p in owned.children(recursive=True):
                    p.kill()
                child.kill()
                child.wait()
        for stream in streams:
            stream.close()


if __name__ == '__main__':
    main()
