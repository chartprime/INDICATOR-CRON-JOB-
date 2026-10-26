# Historical L2 service

[Archive query service](06-archive-query-service.md) · [L2 serving contract](../architecture/l2/historical-serving.md)

Status: production activation remains pending review. Isolated loopback and private VPN qualification services exercise the reader, optional indexes and candle/L1 compatibility; their success does not activate the production route. Local terminals and the month retry are stopped. See the [review status](../architecture/l2/historical-review-status.md) for acceptance gaps. The collector and source catalog do not need to be restarted.

After code review and merge, use the merged development release to prove one qualified ES window first. Perform the owner's manual visual check there, alongside actual candles and L1, before expanding to all indicators, instruments and dates. Merging the branch alone does not configure or start the L2 service.

## Qualify additional index dates

The verification scripts under `apps/runtime/scripts/verify/databento/` operate on retained, independently qualified source data. They do not repeat acquisition, write to S3 or activate serving.

1. `prepare_historical_index_plan.py` reads the immutable published catalog, descriptors and event manifests. Every available day must match a retained candidate by SHA-256. Keep the resulting plan and its hash with the frozen worker/code bundle.
2. `run_historical_index_plan.py` requires that exact plan hash and a private output directory. Run on Linux with at most four lanes, low priority, a four-CPU quota and an eight-GiB hard memory limit. It refuses a second concurrent runner and preserves a 40-GiB disk reserve.
3. Each day derives sealed walls, compares every sample with a fresh engine reading the original depth/trade input, then derives the individual-print index. Failed or interrupted attempts remain provisional; a retry uses a new attempt directory. Resume rechecks completed hashes and the native proof's release, descriptor and wall-manifest bindings.
4. `status.json` reports pending/running/passed/failed/stopped days. Only complete qualification emits both protected serving registries and `complete.json` with `LOCAL_VERIFIED` and `published: false`. These artifacts still require release review and the activation checklist below.

The current month root retains 84 qualified days. Eight dates need a new attempt with the repaired wall worker, including an AAPL auction second with 49,160 contiguous engine events. The reviewed projection retains a 65,536-event count limit and an independent 8-MiB payload limit. Keep both limits enabled; unit burst checks do not replace each day's native comparison. Resume only the explicitly requested qualification run, preserving its existing receipts and frozen code identities.

For an isolated laptop preview, `serve-historical-l2-preview.js` defaults to loopback port 8005. Its only optional bind is the existing WireGuard address `10.88.0.1`, selected by `TT_L2_PREVIEW_HOST`. Permit that port only on the VPN interface, retain viewer authentication, and remove the temporary listener/firewall rule when the preview ends. SSH forwarding and public listeners are not required.

## Boundaries

| Component | Configuration |
|---|---|
| Python reader | `terminal-archive-l2-query.service`, user `ttquery`, loopback port 8004 |
| Cache | `/srv/terminal-data/query-cache/l2`, owner-only; separate from candle/L1 caches |
| Source | `chartprime-historical-data/curated/l2-core/`; exact `GetObject` reads, no raw access or bucket listing |
| Gateway route | Bearer-authenticated `/archive/l2`; existing viewer identity and service-secret boundary |
| Optional gateway setting | `TT_L2_ARCHIVE_SERVICE_URL=http://127.0.0.1:8004/query` |
| Credentials | Existing protected `/etc/terminal-l1-l2/query/service.env`; never a browser build or log |
| Limits | Two reader workers; 2 CPU quota; 2 GiB memory high / 4 GiB hard; 40 GiB free disk reserve |

An unset gateway URL leaves L2 refused and preserves the existing gateway's readiness. An explicitly configured invalid URL makes gateway health report the L2 configuration failure. Do not enable the URL before its service and release have passed review.

## Activation checklist

The four qualified pilots are active on reviewed application release `20261010T140843Z-12f52bdbe1a9.8PGtnw` through the normal gateway. The dedicated reader runs as `ttquery` on loopback 8004 with read-only pilot ACLs; the cache is owner-only. Catalog authentication, all 4,923 pilot-part hashes, normal gateway paging and legacy candle/L1 reads passed. This activation does not qualify the full month or desktop visuals. Month retries remain stopped.

In the repaired web preview, **Open L2 sample** selects a catalog-qualified 15-minute window at 13:30 UTC with one-minute candles. ES/NQ/TSLA use August 5; AAPL uses August 3. **Last 30m of depth** selects the latest loaded date and may lack walls or individual prints. Hover the selected indicator name for its settings gear. Passive Heatmap starts with one-tick bands, no quiet zone and no display size minimum; these settings are stored separately from live mode. Historical heatmap settings do not offer live history loading or lane selection.

- [ ] Record the approved release SHA, previous application release and current immutable L2 pointer. Confirm the approved release contains the new Python reader, gateway route and web integration.
- [ ] Install the reviewed unit through the existing operations installer and run the query-role preparation script. Check `ttquery` owns the L2 cache with mode 0700 and has no write access to curated source data.
- [ ] Validate the unit and its resolved executable paths with `systemd-analyze verify`. Confirm the existing query identity can read the exact L2 pointer, catalog, descriptors and parts. No new S3 write permission is required.
- [ ] For wall/print studies, prepare protected index roots and registries, validate every declared hash and bind each index to the intended immutable release. Supply paired `--wall-index-root`/`--wall-index-registry` and `--print-index-root`/`--print-index-registry` arguments in the reviewed unit. Grant `ttquery` read access only; verify advertised index coverage and fixed wall profiles. The four pilot days do not qualify all August dates.
- [ ] Start the L2 reader alone. Verify loopback health on port 8004, resource limits and secret authentication. Keep the gateway URL unset while this check runs.
- [ ] Run the read-only serving verifier against the approved code and real release. Require field-by-field reference agreement, complete paging, released cache pins, cold/warm timings and no collector health regression.
- [ ] Enable the optional URL in the protected gateway environment, then restart only the reviewed gateway unit. Its unit does not automatically start the L2 reader.
- [ ] Through the actual authenticated gateway, verify catalog discovery and a bounded published-date read; refuse an unauthenticated request. Check legacy candles/L1 and `/archive/study` still work.
- [ ] In the approved web build, verify all 12 L2 entries on dates with their required inputs, unsupported dates/families, gaps, top-ten labels, contract/share units, fixed-profile settings, zoom refusal, progress, rapid panning, token expiry and stale-request cancellation. Record actual cold/warm loading, combined candles/L1 rendering, frame time, memory, bytes and request counts. Missing wall/print coverage must keep dependent studies unavailable.

## Rollback

Remove `TT_L2_ARCHIVE_SERVICE_URL` from the protected gateway environment and restart only the gateway. Confirm `/archive/l2` refuses with the L2 contract and existing candle/L1 routes remain healthy. Stop the dedicated L2 reader after in-flight work has ended. If application rollback is needed, use the recorded previous reviewed release under the existing release procedure.

Do not delete published objects, alter the source candle/L1 pointer, clear active cache pins or stop qualification/collection jobs as part of reader rollback. A later L2 data release uses its publication receipt and verified pointer rollback procedure separately.
