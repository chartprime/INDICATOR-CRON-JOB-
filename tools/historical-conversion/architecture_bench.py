import concurrent.futures
import csv
import json
import os
from pathlib import Path
import platform
import sqlite3
import statistics
import threading
import time
import uuid

import duckdb
import psutil
from convert import REPO, csv_rows, dbn_rows, digest


def run():
    root = Path(os.environ.get('TT_ARCHITECTURE_ROOT', str(REPO / 'apps/runtime/data/conversion-prototype')))
    if psutil.disk_usage(str(root)).free < 8 * 1024**3:
        raise RuntimeError('Require 8 GiB free scratch')
    output = root / ('architecture-' + uuid.uuid4().hex[:8])
    output.mkdir()
    report = {'scope': 'full input files, narrow projection; no canonical publication',
              'platform': platform.platform(), 'python': platform.python_version(),
              'duckdb': duckdb.__version__, 'logicalCpus': psutil.cpu_count(),
              'totalMemoryBytes': psutil.virtual_memory().total,
              'freeDiskBeforeBytes': psutil.disk_usage(str(root)).free,
              'scriptSha256': digest(__file__), 'runs': [],
              'limitations': ['OS cache not cleared', 'single host; see platform field',
                              'projection omits L2 book reconstruction',
                              'concurrency measures query clients, not replay sessions',
                              'SQLite synthetic capture is not production collector qualification']}
    process = psutil.Process()
    stop = threading.Event()
    rss = []

    def sample():
        while not stop.wait(.05):
            rss.append(process.memory_info().rss)

    observer = threading.Thread(target=sample, daemon=True)
    observer.start()
    try:
        for name, kind in [('btc-spot-trades.csv.gz', 'trade'), ('aapl-mbp10.dbn.zst', 'depth')]:
            source = root / 'samples' / name
            sha = digest(source)
            projected = output / (kind + '.csv')
            metadata = {}
            rows = csv_rows(source) if kind == 'trade' else dbn_rows(source, metadata)
            start = time.perf_counter()
            cpu = process.cpu_times()
            count = 0
            minimum = None
            maximum = None
            with projected.open('x', newline='') as f:
                writer = csv.writer(f)
                writer.writerow(['position', 'event_ns', 'price', 'size'])
                for row in rows:
                    event = int(row['timestamp']) * 1000 if kind == 'trade' else int(row['ts_event'])
                    writer.writerow([count, event, row['price'], row['amount'] if kind == 'trade' else row['size']])
                    count += 1
                    minimum = event if minimum is None else min(minimum, event)
                    maximum = event if maximum is None else max(maximum, event)
                    if count % 10000 == 0 and (f.tell() > 1024**3 or time.perf_counter() - start > 300):
                        raise RuntimeError('FULL_FILE_BENCHMARK_BOUND_EXCEEDED')
            decode_seconds = time.perf_counter() - start
            if digest(source) != sha or not count:
                raise RuntimeError('SOURCE_CHANGED_OR_EMPTY')
            c = duckdb.connect(str(output / (kind + '.duckdb')), config={'memory_limit': '256MB', 'threads': 1, 'max_temp_directory_size': '512MB'})
            load_start = time.perf_counter()
            c.execute("CREATE TABLE observations AS SELECT * FROM read_csv(?, header=true, columns={'position':'UBIGINT','event_ns':'UBIGINT','price':'VARCHAR','size':'VARCHAR'}) ORDER BY event_ns,position", [str(projected)])
            parquet = output / (kind + '.parquet')
            c.execute("COPY observations TO ? (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 8192)", [str(parquet)])
            c.execute('CHECKPOINT')
            load_seconds = time.perf_counter() - load_start
            indexed = sqlite3.connect(output / (kind + '.sqlite'))
            indexed.execute('CREATE TABLE observations(position INTEGER, event_ns INTEGER, price TEXT, size TEXT)')
            cursor = c.execute('SELECT * FROM observations')
            while batch := cursor.fetchmany(8192):
                indexed.executemany('INSERT INTO observations VALUES (?,?,?,?)', batch)
            indexed.execute('CREATE INDEX time_position ON observations(event_ns,position)')
            indexed.commit()
            seek = (minimum + maximum) // 2
            sql = 'SELECT * FROM observations WHERE event_ns >= ? ORDER BY event_ns,position LIMIT 1000'
            pq_sql = 'SELECT * FROM read_parquet(?) WHERE event_ns >= ? ORDER BY event_ns,position LIMIT 1000'
            expected = indexed.execute(sql, [seek]).fetchall()
            timings = {}
            for label, query in [('indexedSQLite', lambda: indexed.execute(sql, [seek]).fetchall()),
                                 ('materializedDuckDB', lambda: c.execute(sql, [seek]).fetchall()),
                                 ('directParquet', lambda: c.execute(pq_sql, [str(parquet), seek]).fetchall())]:
                measurements = []
                for _ in range(10):
                    begin = time.perf_counter()
                    actual = query()
                    measurements.append((time.perf_counter() - begin) * 1000)
                    if actual != expected:
                        raise RuntimeError('QUERY_RESULT_MISMATCH')
                timings[label] = {'milliseconds': measurements, 'medianMs': statistics.median(measurements), 'returnedRows': len(expected)}
            c.close()
            indexed.close()
            barrier = threading.Barrier(10, timeout=30)

            def reader():
                conn = duckdb.connect(config={'memory_limit': '64MB', 'threads': 1})
                try:
                    barrier.wait()
                    durations = []
                    for _ in range(20):
                        begin = time.perf_counter()
                        actual = conn.execute(pq_sql, [str(parquet), seek]).fetchall()
                        if actual != expected:
                            raise RuntimeError('CONCURRENT_QUERY_MISMATCH')
                        durations.append((time.perf_counter() - begin) * 1000)
                    return durations
                finally:
                    conn.close()

            def writer_load():
                conn = sqlite3.connect(output / (kind + '-synthetic-capture.sqlite'))
                try:
                    conn.execute('PRAGMA journal_mode=WAL')
                    conn.execute('PRAGMA synchronous=FULL')
                    conn.execute('CREATE TABLE events(id INTEGER PRIMARY KEY, payload TEXT)')
                    barrier.wait()
                    begin = time.perf_counter()
                    for batch in range(200):
                        conn.executemany('INSERT INTO events VALUES (?,?)', [(batch*100+i, 'x'*256) for i in range(100)])
                        conn.commit()
                    if conn.execute('SELECT count(*) FROM events').fetchone()[0] != 20000:
                        raise RuntimeError('CAPTURE_ROW_MISMATCH')
                    return {'rows': 20000, 'seconds': time.perf_counter()-begin, 'payloadBytesPerRow': 256, 'synthetic': True}
                finally:
                    conn.close()

            def decode_load():
                barrier.wait()
                begin = time.perf_counter()
                n = sum(1 for _ in (csv_rows(source) if kind == 'trade' else dbn_rows(source, {})))
                if n != count:
                    raise RuntimeError('CONCURRENT_DECODE_COUNT_MISMATCH')
                return {'rows': n, 'seconds': time.perf_counter()-begin, 'scope': 'decode only, not canonical mapping'}

            with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
                readers = [pool.submit(reader) for _ in range(8)]
                write_result = pool.submit(writer_load)
                decode_result = pool.submit(decode_load)
                durations = [x for future in readers for x in future.result()]
                concurrent_result = {'queries': len(durations), 'medianMs': statistics.median(durations),
                                     'p95Ms': sorted(durations)[int(len(durations)*.95)-1],
                                     'maxMs': max(durations), 'capture': write_result.result(), 'decode': decode_result.result()}
            final_cpu = process.cpu_times()
            result = {'input': name, 'sha256': sha, 'inputBytes': source.stat().st_size,
                      'scope': 'COMPLETE_INPUT_FILE_NOT_COVERAGE_CERTIFICATION', 'rows': count,
                      'minimumNs': str(minimum), 'maximumNs': str(maximum),
                      'projectionDecodeSeconds': decode_seconds, 'loadAndParquetSeconds': load_seconds,
                      'cpuSecondsIncludingQueries': final_cpu.user+final_cpu.system-cpu.user-cpu.system,
                      'projectionCsvBytes': projected.stat().st_size, 'parquetBytes': parquet.stat().st_size,
                      'materializedBytes': (output / (kind+'.duckdb')).stat().st_size,
                      'indexedBytes': (output / (kind+'.sqlite')).stat().st_size,
                      'queries': timings, 'concurrent': concurrent_result}
            report['runs'].append(result)
            print(json.dumps(result), flush=True)
        report['sampledPeakProcessRssBytes'] = max(rss)
        report['retainedScratchBytes'] = sum(p.stat().st_size for p in output.rglob('*') if p.is_file())
        report['freeDiskAfterBytes'] = psutil.disk_usage(str(root)).free
        (output / 'report.json').write_text(json.dumps(report, indent=2)+'\n')
        print(str(output / 'report.json'), flush=True)
    finally:
        stop.set()
        observer.join()


if __name__ == '__main__':
    run()

