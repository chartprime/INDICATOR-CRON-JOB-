#!/usr/bin/env python3
"""Bounded, read-only capture evidence. Run as the capture owner; no secrets."""
import argparse
import datetime
import json
import pathlib
import sqlite3
import time


def inspect(path):
    path = pathlib.Path(path).resolve(strict=True)
    deadline = time.monotonic() + 20
    db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=2)
    db.row_factory = sqlite3.Row
    try:
        db.execute('PRAGMA query_only=ON')
        db.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
        db.execute('BEGIN')
        sessions = [dict(r) for r in db.execute(
            'SELECT * FROM capture_sessions ORDER BY started_at DESC LIMIT 5')]
        incident_groups = [dict(r) for r in db.execute(
            'SELECT session_id, severity, event, market_kind, symbol, COUNT(*) AS records, '
            'SUM(affected_count) AS affected_count, MIN(ts) AS first_ts, MAX(ts) AS last_ts '
            'FROM capture_incidents GROUP BY session_id,severity,event,market_kind,symbol')]
        latest = []
        for symbol in ('BTCUSDT', 'ETHUSDT'):
            for market in ('SPOT', 'PERPETUAL'):
                for table, column in (('trades', 'ts'), ('candles', 'ts_open'),
                                      ('l2_depth_events', 'ts'), ('l2_depth_snapshots', 'captured_at')):
                    row = db.execute(f'SELECT {column} FROM {table} WHERE symbol=? AND market_kind=? '
                                     f'ORDER BY {column} DESC LIMIT 1', (symbol, market)).fetchone()
                    latest.append(dict(symbol=symbol, market_kind=market, table=table,
                                       latest_ts=row[0] if row else None))
        db.rollback()
        return dict(observed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    sessions=sessions, incident_groups=incident_groups, latest=latest,
                    file_bytes={suffix or 'db': pathlib.Path(str(path)+suffix).stat().st_size
                                for suffix in ('', '-wal', '-shm')
                                if pathlib.Path(str(path)+suffix).exists()},
                    notes=['Open session quality is finalized on shutdown; consult incidents.',
                           'Latest timestamps prove recorded freshness, not absence of gaps.',
                           'File sizes are sampled after the read transaction, not atomically with rows.',
                           'Affected counts are not a complete missing-event reconciliation.'])
    finally:
        db.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database')
    args = parser.parse_args()
    print(json.dumps(inspect(args.database), indent=2))
