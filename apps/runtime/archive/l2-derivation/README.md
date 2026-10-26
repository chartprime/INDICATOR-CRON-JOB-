# L2 derivation (parked, not deleted)

`l2-zone-scanner.js` (zone bucketing, qualifying-threshold filtering, per-side
cap) and `l2-change-detector.js` (change-event labeling) used to run live
inside the Terminal 0 collector, writing derived `l2_zone_snapshots`/
`l2_change_events` tables. As of the raw-only Phase 2 restructuring, the
collector only archives raw data (`trades`, `candles`, `l2_depth_events`,
`l2_depth_snapshots`) —
zone-scanning is Phase 4 work (indicator/derivation logic), not collection.

These are pure functions with no wiring dependency on the collector, so
they're parked here rather than deleted: whenever Phase 4 actually gets
built, it can begin each replay from the matching raw
`l2_depth_snapshots` baseline, apply the subsequent `l2_depth_events`, and
call these same functions exactly as before, unchanged. Their tests move with
them and keep passing as a self-contained, currently-unused unit.
