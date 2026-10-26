# Compression Breakout live observation run

## BTC-USDT

Recorded 2026-10-26T17:17:03.190Z to 2026-10-26T17:47:03.215Z: snapshot 10080 bars, 1819 bar frames (30 closes, 31 distinct open times), mutations {"APPENDED":31,"REPLACED_EDGE":1772,"REBUILT":16}.

Live versus replay of the 10080 retained bars (the rollover dropped 30 older bars the live instance had seen): first quiet bar at retained index 228 (2026-10-19T21:36:00.000Z), 9852 bars compared after it with 0 seam disagreements; 3 seam cells differ before the quiet bar (the replay starts cold); confirmed markers after the quiet bar live-only 0, replay-only 0; later snapshot re-sends during the run: 22; faulted: false.

Ranges opened over the retained series: 20. Markers: 7 on 1m (0.7 per 1,000, max 1 per bar); 4 on resampled 5m over 2016 bars (2.0 per 1,000).

Events, product (left) and plain frozen-range baseline (right):

| Product | Plain frozen range |
|---|---|
| 10-19 20:50 break ↓ grade 1 basis 3 | 10-19 21:14 break ↑ grade 3 basis 3 |
| 10-19 20:55 held outside | 10-19 21:16 failed |
| 10-20 19:21 break ↓ grade 3 basis 3 | 10-19 21:52 break ↓ grade 0 basis 3 |
| 10-20 19:26 held outside | 10-19 21:57 held outside |
| 10-22 03:12 break ↓ grade 0 basis 3 | 10-19 23:07 break ↓ grade 1 basis 3 |
| 10-22 03:14 failed | 10-19 23:12 held outside |
| 10-22 07:50 break ↓ grade 3 basis 3 | 10-19 23:56 break ↓ grade 0 basis 3 |
| 10-22 07:52 failed | 10-20 00:01 held outside |
| 10-23 13:04 break ↓ grade 0 basis 3 | 10-20 01:09 break ↓ grade 3 basis 3 |
| 10-23 13:09 held outside | 10-20 01:14 held outside |
| 10-24 04:51 break ↑ grade 0 basis 3 | 10-20 01:46 break ↑ grade 3 basis 3 |
| 10-24 04:56 held outside | 10-20 01:49 failed |
| 10-24 06:56 break ↓ grade 0 basis 3 | 10-20 02:04 break ↓ grade 1 basis 3 |
| 10-24 06:59 failed | 10-20 02:05 failed |
| 10-24 19:47 break ↓ grade 3 basis 3 | 10-20 02:50 break ↑ grade 3 basis 3 |
| 10-24 19:48 failed | 10-20 02:51 failed |
| 10-25 07:35 break ↑ grade 1 basis 3 | 10-20 03:08 break ↑ grade 3 basis 3 |
| 10-25 07:40 held outside | 10-20 03:13 held outside |
| 10-26 10:01 break ↓ grade 3 basis 3 | 10-20 03:36 break ↑ grade 3 basis 3 |
| 10-26 10:03 failed | 10-20 03:41 failed |
|  | 10-20 04:20 break ↑ grade 1 basis 3 |
|  | 10-20 04:23 failed |
|  | 10-20 04:52 break ↓ grade 0 basis 3 |
|  | 10-20 04:53 failed |
|  | 10-20 05:05 break ↓ grade 1 basis 3 |
|  | 10-20 05:10 failed |
|  | 10-20 05:30 break ↓ grade 1 basis 3 |
|  | 10-20 05:32 failed |
|  | 10-20 05:56 break ↓ grade 0 basis 3 |
|  | 10-20 06:01 held outside |
|  | 10-20 06:13 break ↓ grade 0 basis 3 |
|  | 10-20 06:14 failed |
|  | 10-20 06:40 break ↑ grade 0 basis 3 |
|  | 10-20 06:45 failed |
|  | 10-20 07:16 break ↓ grade 1 basis 3 |
|  | 10-20 07:17 failed |
|  | 10-20 07:53 break ↓ grade 0 basis 3 |
|  | 10-20 07:54 failed |
|  | 10-20 08:27 break ↑ grade 0 basis 3 |
|  | 10-20 08:28 failed |
|  | 10-20 08:50 break ↓ grade 3 basis 3 |
|  | 10-20 08:51 failed |
|  | 10-20 09:15 break ↓ grade 0 basis 3 |
|  | 10-20 09:16 failed |
|  | 10-20 09:36 break ↓ grade 2 basis 3 |
|  | 10-20 09:38 failed |
|  | 10-20 09:46 break ↓ grade 0 basis 3 |
|  | 10-20 09:47 failed |
|  | 10-20 09:57 break ↑ grade 0 basis 3 |
|  | 10-20 10:02 held outside |
|  | 10-20 10:42 break ↓ grade 0 basis 3 |
|  | 10-20 10:43 failed |
|  | 10-20 11:01 break ↑ grade 1 basis 3 |
|  | 10-20 11:02 failed |
|  | 10-20 11:19 break ↓ grade 0 basis 3 |
|  | 10-20 11:24 failed |
|  | 10-20 11:40 break ↑ grade 1 basis 3 |
|  | 10-20 11:42 failed |
|  | 10-20 12:08 break ↓ grade 3 basis 3 |
|  | 10-20 12:13 held outside |
|  | 10-20 12:44 break ↑ grade 0 basis 3 |
|  | 10-20 12:45 failed |
|  | 10-20 13:14 break ↓ grade 0 basis 3 |
|  | 10-20 13:15 failed |
|  | 10-20 13:31 break ↓ grade 3 basis 3 |
|  | 10-20 13:34 failed |
|  | 10-20 13:58 break ↑ grade 1 basis 3 |
|  | 10-20 14:03 held outside |
|  | 10-20 14:41 break ↑ grade 2 basis 3 |
|  | 10-20 14:44 failed |
|  | 10-20 14:57 break ↑ grade 3 basis 3 |
|  | 10-20 14:58 failed |
|  | 10-20 15:11 break ↓ grade 0 basis 3 |
|  | 10-20 15:16 held outside |
|  | 10-21 00:14 break ↑ grade 1 basis 3 |
|  | 10-21 00:19 held outside |
|  | 10-21 01:00 break ↓ grade 3 basis 3 |
|  | 10-21 01:05 held outside |
|  | 10-21 01:50 break ↑ grade 2 basis 3 |
|  | 10-21 01:51 failed |
|  | 10-21 02:13 break ↓ grade 3 basis 3 |
|  | 10-21 02:18 held outside |
|  | 10-21 02:31 break ↓ grade 0 basis 3 |
|  | 10-21 02:32 failed |
|  | 10-21 05:03 break ↑ grade 2 basis 3 |
|  | 10-21 05:08 held outside |
|  | 10-21 05:41 break ↓ grade 3 basis 3 |
|  | 10-21 05:46 failed |
|  | 10-21 07:28 break ↑ grade 3 basis 3 |
|  | 10-21 07:33 held outside |
|  | 10-21 07:52 break ↑ grade 0 basis 3 |
|  | 10-21 07:53 failed |
|  | 10-21 08:28 break ↑ grade 3 basis 3 |
|  | 10-21 08:29 failed |
|  | 10-21 08:43 break ↑ grade 3 basis 3 |
|  | 10-21 08:44 failed |
|  | 10-21 13:04 break ↑ grade 3 basis 3 |
|  | 10-21 13:09 held outside |
|  | 10-21 13:34 break ↓ grade 1 basis 3 |
|  | 10-21 13:38 failed |
|  | 10-21 13:47 break ↑ grade 3 basis 3 |
|  | 10-21 13:52 failed |
|  | 10-21 14:23 break ↑ grade 2 basis 3 |
|  | 10-21 14:28 failed |
|  | 10-21 15:09 break ↑ grade 0 basis 3 |
|  | 10-21 15:12 failed |
|  | 10-21 16:39 break ↑ grade 3 basis 3 |
|  | 10-21 16:40 failed |
|  | 10-21 16:51 break ↓ grade 0 basis 3 |
|  | 10-21 16:56 held outside |
|  | 10-21 17:34 break ↑ grade 1 basis 3 |
|  | 10-21 17:39 held outside |
|  | 10-21 17:58 break ↑ grade 0 basis 3 |
|  | 10-21 17:59 failed |
|  | 10-21 18:22 break ↑ grade 1 basis 3 |
|  | 10-21 18:27 held outside |
|  | 10-21 18:47 break ↓ grade 3 basis 3 |
|  | 10-21 18:52 held outside |
|  | 10-21 21:27 break ↑ grade 1 basis 3 |
|  | 10-21 21:29 failed |
|  | 10-21 21:42 break ↑ grade 0 basis 3 |
|  | 10-21 21:43 failed |
|  | 10-21 22:00 break ↓ grade 3 basis 3 |
|  | 10-21 22:05 held outside |
|  | 10-21 22:17 break ↓ grade 1 basis 3 |
|  | 10-21 22:22 held outside |
|  | 10-21 22:43 break ↓ grade 3 basis 3 |
|  | 10-21 22:48 held outside |
|  | 10-21 22:59 break ↓ grade 3 basis 3 |
|  | 10-21 23:00 failed |
|  | 10-21 23:36 break ↓ grade 0 basis 3 |
|  | 10-21 23:37 failed |
|  | 10-22 00:39 break ↑ grade 0 basis 3 |
|  | 10-22 00:44 held outside |
|  | 10-22 01:00 break ↓ grade 3 basis 3 |
|  | 10-22 01:05 held outside |
|  | 10-22 01:16 break ↑ grade 0 basis 3 |
|  | 10-22 01:17 failed |
|  | 10-22 01:34 break ↓ grade 3 basis 3 |
|  | 10-22 01:39 held outside |
|  | 10-22 01:52 break ↓ grade 0 basis 3 |
|  | 10-22 01:57 held outside |
|  | 10-22 02:17 break ↓ grade 0 basis 3 |
|  | 10-22 02:22 held outside |
|  | 10-22 03:23 break ↓ grade 0 basis 3 |
|  | 10-22 03:28 held outside |
|  | 10-22 03:43 break ↑ grade 0 basis 3 |
|  | 10-22 03:48 held outside |
|  | 10-22 04:00 break ↑ grade 2 basis 3 |
|  | 10-22 04:01 failed |
|  | 10-22 04:35 break ↓ grade 1 basis 3 |
|  | 10-22 04:40 held outside |
|  | 10-22 05:02 break ↑ grade 1 basis 3 |
|  | 10-22 05:04 failed |
|  | 10-22 05:28 break ↑ grade 1 basis 3 |
|  | 10-22 05:29 failed |
|  | 10-22 05:50 break ↓ grade 1 basis 3 |
|  | 10-22 05:55 held outside |
|  | 10-22 06:07 break ↑ grade 3 basis 3 |
|  | 10-22 06:09 failed |
|  | 10-22 06:26 break ↓ grade 3 basis 3 |
|  | 10-22 06:31 held outside |
|  | 10-22 06:44 break ↓ grade 0 basis 3 |
|  | 10-22 06:49 held outside |
|  | 10-22 07:03 break ↓ grade 1 basis 3 |
|  | 10-22 07:04 failed |
|  | 10-22 07:26 break ↓ grade 0 basis 3 |
|  | 10-22 07:27 failed |
|  | 10-22 07:50 break ↓ grade 3 basis 3 |
|  | 10-22 07:52 failed |
|  | 10-22 08:10 break ↓ grade 0 basis 3 |
|  | 10-22 08:11 failed |
|  | 10-22 08:19 break ↓ grade 2 basis 3 |
|  | 10-22 08:24 held outside |
|  | 10-22 08:58 break ↓ grade 3 basis 3 |
|  | 10-22 09:03 held outside |
|  | 10-22 10:00 break ↑ grade 2 basis 3 |
|  | 10-22 10:05 held outside |
|  | 10-22 10:23 break ↑ grade 1 basis 3 |
|  | 10-22 10:24 failed |
|  | 10-22 10:34 break ↑ grade 1 basis 3 |
|  | 10-22 10:35 failed |
|  | 10-22 10:56 break ↓ grade 3 basis 3 |
|  | 10-22 10:57 failed |
|  | 10-22 11:15 break ↓ grade 3 basis 3 |
|  | 10-22 11:16 failed |
|  | 10-22 11:47 break ↓ grade 1 basis 3 |
|  | 10-22 11:52 held outside |
|  | 10-22 12:18 break ↑ grade 0 basis 3 |
|  | 10-22 12:19 failed |
|  | 10-22 12:35 break ↓ grade 0 basis 3 |
|  | 10-22 12:36 failed |
|  | 10-22 12:58 break ↓ grade 0 basis 3 |
|  | 10-22 12:59 failed |
|  | 10-22 13:13 break ↓ grade 3 basis 3 |
|  | 10-22 13:15 failed |
|  | 10-22 16:45 break ↓ grade 2 basis 3 |
|  | 10-22 16:50 held outside |
|  | 10-23 01:36 break ↓ grade 0 basis 3 |
|  | 10-23 01:38 failed |
|  | 10-23 02:31 break ↑ grade 3 basis 3 |
|  | 10-23 02:36 held outside |
|  | 10-23 03:52 break ↑ grade 1 basis 3 |
|  | 10-23 03:55 failed |
|  | 10-23 04:07 break ↓ grade 1 basis 3 |
|  | 10-23 04:12 held outside |
|  | 10-23 04:28 break ↓ grade 1 basis 3 |
|  | 10-23 04:31 failed |
|  | 10-23 04:56 break ↓ grade 0 basis 3 |
|  | 10-23 05:01 failed |
|  | 10-23 05:50 break ↑ grade 0 basis 3 |
|  | 10-23 05:51 failed |
|  | 10-23 06:10 break ↑ grade 0 basis 3 |
|  | 10-23 06:11 failed |
|  | 10-23 07:15 break ↓ grade 1 basis 3 |
|  | 10-23 07:16 failed |
|  | 10-23 07:43 break ↓ grade 1 basis 3 |
|  | 10-23 07:48 held outside |
|  | 10-23 08:15 break ↑ grade 3 basis 3 |
|  | 10-23 08:20 held outside |
|  | 10-23 09:38 break ↓ grade 3 basis 3 |
|  | 10-23 09:40 failed |
|  | 10-23 10:12 break ↑ grade 2 basis 3 |
|  | 10-23 10:17 held outside |
|  | 10-23 11:02 break ↓ grade 0 basis 3 |
|  | 10-23 11:03 failed |
|  | 10-23 11:50 break ↑ grade 0 basis 3 |
|  | 10-23 11:51 failed |
|  | 10-23 12:07 break ↓ grade 1 basis 3 |
|  | 10-23 12:08 failed |
|  | 10-23 12:25 break ↑ grade 3 basis 3 |
|  | 10-23 12:26 failed |
|  | 10-23 13:23 break ↑ grade 3 basis 3 |
|  | 10-23 13:27 failed |
|  | 10-23 13:40 break ↑ grade 3 basis 3 |
|  | 10-23 13:45 held outside |
|  | 10-23 14:12 break ↓ grade 0 basis 3 |
|  | 10-23 14:14 failed |
|  | 10-23 22:45 break ↓ grade 0 basis 3 |
|  | 10-23 22:50 held outside |
|  | 10-23 23:10 break ↓ grade 3 basis 3 |
|  | 10-23 23:11 failed |
|  | 10-23 23:21 break ↑ grade 0 basis 3 |
|  | 10-23 23:26 held outside |
|  | 10-23 23:45 break ↑ grade 3 basis 3 |
|  | 10-23 23:50 held outside |
|  | 10-24 00:18 break ↓ grade 0 basis 3 |
|  | 10-24 00:23 held outside |
|  | 10-24 00:35 break ↓ grade 0 basis 3 |
|  | 10-24 00:37 failed |
|  | 10-24 01:49 break ↑ grade 0 basis 3 |
|  | 10-24 01:54 held outside |
|  | 10-24 02:09 break ↑ grade 1 basis 3 |
|  | 10-24 02:10 failed |
|  | 10-24 02:59 break ↑ grade 3 basis 3 |
|  | 10-24 03:04 held outside |
|  | 10-24 03:48 break ↓ grade 1 basis 3 |
|  | 10-24 03:53 held outside |
|  | 10-24 04:21 break ↓ grade 1 basis 3 |
|  | 10-24 04:22 failed |
|  | 10-24 05:11 break ↓ grade 0 basis 3 |
|  | 10-24 05:13 failed |
|  | 10-24 05:43 break ↓ grade 1 basis 3 |
|  | 10-24 05:44 failed |
|  | 10-24 06:02 break ↓ grade 1 basis 3 |
|  | 10-24 06:04 failed |
|  | 10-24 07:02 break ↑ grade 3 basis 3 |
|  | 10-24 07:07 held outside |
|  | 10-24 07:31 break ↓ grade 1 basis 3 |
|  | 10-24 07:32 failed |
|  | 10-24 07:55 break ↓ grade 3 basis 3 |
|  | 10-24 08:00 failed |
|  | 10-24 08:38 break ↓ grade 3 basis 3 |
|  | 10-24 08:43 held outside |
|  | 10-24 09:04 break ↓ grade 0 basis 3 |
|  | 10-24 09:05 failed |
|  | 10-24 09:19 break ↓ grade 2 basis 3 |
|  | 10-24 09:24 held outside |
|  | 10-24 09:37 break ↓ grade 3 basis 3 |
|  | 10-24 09:39 failed |
|  | 10-24 10:03 break ↑ grade 0 basis 3 |
|  | 10-24 10:05 failed |
|  | 10-24 10:32 break ↑ grade 3 basis 3 |
|  | 10-24 10:37 held outside |
|  | 10-24 12:20 break ↑ grade 3 basis 3 |
|  | 10-24 12:21 failed |
|  | 10-24 12:46 break ↑ grade 3 basis 3 |
|  | 10-24 12:49 failed |
|  | 10-24 13:18 break ↓ grade 3 basis 3 |
|  | 10-24 13:21 failed |
|  | 10-24 13:32 break ↓ grade 1 basis 3 |
|  | 10-24 13:34 failed |
|  | 10-24 14:11 break ↓ grade 1 basis 3 |
|  | 10-24 14:16 held outside |
|  | 10-24 14:25 break ↓ grade 0 basis 3 |
|  | 10-24 14:28 failed |
|  | 10-24 15:09 break ↓ grade 3 basis 3 |
|  | 10-24 15:10 failed |
|  | 10-24 16:56 break ↑ grade 0 basis 3 |
|  | 10-24 16:58 failed |
|  | 10-24 18:00 break ↑ grade 0 basis 3 |
|  | 10-24 18:01 failed |
|  | 10-24 18:10 break ↑ grade 3 basis 3 |
|  | 10-24 18:15 held outside |
|  | 10-24 18:52 break ↑ grade 2 basis 3 |
|  | 10-24 18:53 failed |
|  | 10-24 21:10 break ↓ grade 1 basis 3 |
|  | 10-24 21:12 failed |
|  | 10-24 22:35 break ↑ grade 3 basis 3 |
|  | 10-24 22:40 held outside |
|  | 10-24 23:30 break ↑ grade 3 basis 3 |
|  | 10-24 23:35 held outside |
|  | 10-24 23:48 break ↑ grade 0 basis 3 |
|  | 10-24 23:53 held outside |
|  | 10-25 00:01 break ↓ grade 1 basis 3 |
|  | 10-25 00:06 held outside |
|  | 10-25 00:14 break ↓ grade 0 basis 3 |
|  | 10-25 00:19 held outside |
|  | 10-25 00:28 break ↑ grade 1 basis 3 |
|  | 10-25 00:33 held outside |
|  | 10-25 00:49 break ↑ grade 0 basis 3 |
|  | 10-25 00:50 failed |
|  | 10-25 01:00 break ↓ grade 1 basis 3 |
|  | 10-25 01:05 held outside |
|  | 10-25 01:32 break ↓ grade 0 basis 3 |
|  | 10-25 01:36 failed |
|  | 10-25 02:05 break ↑ grade 2 basis 3 |
|  | 10-25 02:10 held outside |
|  | 10-25 02:39 break ↑ grade 3 basis 3 |
|  | 10-25 02:42 failed |
|  | 10-25 03:17 break ↑ grade 2 basis 3 |
|  | 10-25 03:22 held outside |
|  | 10-25 03:47 break ↓ grade 1 basis 3 |
|  | 10-25 03:52 held outside |
|  | 10-25 04:38 break ↑ grade 2 basis 3 |
|  | 10-25 04:39 failed |
|  | 10-25 05:23 break ↓ grade 1 basis 3 |
|  | 10-25 05:28 held outside |
|  | 10-25 06:50 break ↓ grade 3 basis 3 |
|  | 10-25 06:55 held outside |
|  | 10-25 07:06 break ↑ grade 3 basis 3 |
|  | 10-25 07:07 failed |
|  | 10-25 07:35 break ↑ grade 1 basis 3 |
|  | 10-25 07:40 held outside |
|  | 10-25 08:17 break ↓ grade 3 basis 3 |
|  | 10-25 08:22 held outside |
|  | 10-25 09:12 break ↓ grade 3 basis 3 |
|  | 10-25 09:17 held outside |
|  | 10-25 11:22 break ↑ grade 0 basis 3 |
|  | 10-25 11:23 failed |
|  | 10-25 11:43 break ↑ grade 1 basis 3 |
|  | 10-25 11:48 held outside |
|  | 10-25 12:25 break ↓ grade 3 basis 3 |
|  | 10-25 12:30 held outside |
|  | 10-25 13:28 break ↓ grade 3 basis 3 |
|  | 10-25 13:33 held outside |
|  | 10-25 13:41 break ↑ grade 3 basis 3 |
|  | 10-25 13:42 failed |
|  | 10-25 14:50 break ↑ grade 3 basis 3 |
|  | 10-25 14:55 held outside |
|  | 10-25 16:55 break ↑ grade 3 basis 3 |
|  | 10-25 17:00 held outside |
|  | 10-25 17:21 break ↑ grade 3 basis 3 |
|  | 10-25 17:22 failed |
|  | 10-25 18:09 break ↓ grade 3 basis 3 |
|  | 10-25 18:14 held outside |
|  | 10-25 18:29 break ↓ grade 0 basis 3 |
|  | 10-25 18:30 failed |
|  | 10-25 18:43 break ↓ grade 3 basis 3 |
|  | 10-25 18:45 failed |
|  | 10-25 19:05 break ↓ grade 1 basis 3 |
|  | 10-25 19:10 held outside |
|  | 10-25 20:02 break ↓ grade 2 basis 3 |
|  | 10-25 20:06 failed |
|  | 10-25 20:14 break ↑ grade 3 basis 3 |
|  | 10-25 20:16 failed |
|  | 10-25 20:45 break ↓ grade 1 basis 3 |
|  | 10-25 20:46 failed |
|  | 10-25 21:24 break ↓ grade 3 basis 3 |
|  | 10-25 21:26 failed |
|  | 10-25 21:44 break ↓ grade 1 basis 3 |
|  | 10-25 21:49 held outside |
|  | 10-25 23:26 break ↓ grade 3 basis 3 |
|  | 10-25 23:31 held outside |
|  | 10-26 01:37 break ↓ grade 3 basis 3 |
|  | 10-26 01:42 held outside |
|  | 10-26 03:50 break ↓ grade 3 basis 3 |
|  | 10-26 03:54 failed |
|  | 10-26 04:04 break ↑ grade 0 basis 3 |
|  | 10-26 04:07 failed |
|  | 10-26 04:36 break ↑ grade 2 basis 3 |
|  | 10-26 04:37 failed |
|  | 10-26 04:53 break ↑ grade 3 basis 3 |
|  | 10-26 04:54 failed |
|  | 10-26 05:25 break ↑ grade 3 basis 3 |
|  | 10-26 05:28 failed |
|  | 10-26 06:10 break ↓ grade 0 basis 3 |
|  | 10-26 06:11 failed |
|  | 10-26 06:24 break ↓ grade 2 basis 3 |
|  | 10-26 06:29 held outside |
|  | 10-26 07:00 break ↑ grade 3 basis 3 |
|  | 10-26 07:04 failed |
|  | 10-26 07:30 break ↓ grade 3 basis 3 |
|  | 10-26 07:31 failed |
|  | 10-26 07:43 break ↑ grade 1 basis 3 |
|  | 10-26 07:44 failed |
|  | 10-26 08:02 break ↓ grade 1 basis 3 |
|  | 10-26 08:07 held outside |
|  | 10-26 08:27 break ↑ grade 3 basis 3 |
|  | 10-26 08:32 held outside |
|  | 10-26 09:17 break ↑ grade 3 basis 3 |
|  | 10-26 09:18 failed |
|  | 10-26 09:43 break ↑ grade 0 basis 3 |
|  | 10-26 09:48 held outside |
|  | 10-26 09:57 break ↑ grade 2 basis 3 |
|  | 10-26 09:58 failed |
|  | 10-26 10:48 break ↓ grade 0 basis 3 |
|  | 10-26 10:49 failed |
|  | 10-26 10:58 break ↓ grade 3 basis 3 |
|  | 10-26 11:03 failed |
|  | 10-26 11:53 break ↑ grade 3 basis 3 |
|  | 10-26 11:57 failed |
|  | 10-26 12:10 break ↓ grade 0 basis 3 |
|  | 10-26 12:11 failed |
|  | 10-26 13:01 break ↓ grade 3 basis 3 |
|  | 10-26 13:06 held outside |
|  | 10-26 13:21 break ↓ grade 0 basis 3 |
|  | 10-26 13:26 held outside |
|  | 10-26 14:19 break ↑ grade 3 basis 3 |
|  | 10-26 14:20 failed |
|  | 10-26 14:48 break ↑ grade 3 basis 3 |
|  | 10-26 14:50 failed |
|  | 10-26 16:00 break ↓ grade 0 basis 3 |
|  | 10-26 16:01 failed |
|  | 10-26 16:14 break ↓ grade 0 basis 3 |
|  | 10-26 16:19 held outside |
|  | 10-26 17:00 break ↑ grade 3 basis 3 |
|  | 10-26 17:05 held outside |

## ETH-USDT

Recorded 2026-10-26T17:17:03.245Z to 2026-10-26T17:47:03.267Z: snapshot 10080 bars, 1242 bar frames (30 closes, 31 distinct open times), mutations {"APPENDED":31,"REPLACED_EDGE":1210,"REBUILT":1}.

Live versus replay of the 10080 retained bars (the rollover dropped 30 older bars the live instance had seen): first quiet bar at retained index 205 (2026-10-19T21:13:00.000Z), 9875 bars compared after it with 0 seam disagreements; 54 seam cells differ before the quiet bar (the replay starts cold); confirmed markers after the quiet bar live-only 0, replay-only 0; later snapshot re-sends during the run: 7; faulted: false.

Ranges opened over the retained series: 26. Markers: 7 on 1m (0.7 per 1,000, max 1 per bar); 3 on resampled 5m over 2016 bars (1.5 per 1,000).

Events, product (left) and plain frozen-range baseline (right):

| Product | Plain frozen range |
|---|---|
| 10-19 23:07 break ↓ grade 0 basis 3 | 10-19 22:01 break ↑ grade 3 basis 3 |
| 10-19 23:12 failed | 10-19 22:02 failed |
| 10-20 14:56 break ↑ grade 2 basis 3 | 10-19 22:16 break ↑ grade 3 basis 3 |
| 10-20 15:00 failed | 10-19 22:21 held outside |
| 10-21 20:00 break ↓ grade 3 basis 3 | 10-19 23:17 break ↓ grade 0 basis 3 |
| 10-21 20:02 failed | 10-19 23:18 failed |
| 10-22 22:01 break ↑ grade 1 basis 3 | 10-19 23:27 break ↑ grade 0 basis 3 |
| 10-22 22:06 held outside | 10-19 23:28 failed |
| 10-24 04:38 break ↑ grade 1 basis 3 | 10-20 00:05 break ↓ grade 1 basis 3 |
| 10-24 04:43 held outside | 10-20 00:10 held outside |
| 10-24 15:00 break ↓ grade 0 basis 3 | 10-20 01:08 break ↓ grade 2 basis 3 |
| 10-24 15:05 held outside | 10-20 01:13 held outside |
| 10-24 15:56 break ↑ grade 2 basis 3 | 10-20 02:48 break ↑ grade 2 basis 3 |
| 10-24 16:01 held outside | 10-20 02:49 failed |
| 10-25 07:41 break ↑ grade 3 basis 3 | 10-20 03:08 break ↑ grade 3 basis 3 |
| 10-25 07:43 failed | 10-20 03:13 held outside |
| 10-25 10:12 break ↑ grade 3 basis 3 | 10-20 03:33 break ↑ grade 0 basis 3 |
| 10-25 10:17 held outside | 10-20 03:35 failed |
| 10-25 18:02 break ↓ grade 1 basis 3 | 10-20 03:46 break ↑ grade 2 basis 3 |
| 10-25 18:03 failed | 10-20 03:51 held outside |
|  | 10-20 04:20 break ↑ grade 1 basis 3 |
|  | 10-20 04:22 failed |
|  | 10-20 05:06 break ↓ grade 2 basis 3 |
|  | 10-20 05:10 failed |
|  | 10-20 05:19 break ↓ grade 0 basis 3 |
|  | 10-20 05:22 failed |
|  | 10-20 05:57 break ↓ grade 3 basis 3 |
|  | 10-20 06:02 held outside |
|  | 10-20 06:13 break ↓ grade 0 basis 3 |
|  | 10-20 06:16 failed |
|  | 10-20 06:30 break ↑ grade 0 basis 3 |
|  | 10-20 06:31 failed |
|  | 10-20 06:40 break ↑ grade 2 basis 3 |
|  | 10-20 06:45 held outside |
|  | 10-20 07:16 break ↓ grade 1 basis 3 |
|  | 10-20 07:17 failed |
|  | 10-20 07:25 break ↓ grade 1 basis 3 |
|  | 10-20 07:27 failed |
|  | 10-20 07:56 break ↓ grade 0 basis 3 |
|  | 10-20 07:57 failed |
|  | 10-20 08:50 break ↓ grade 3 basis 3 |
|  | 10-20 08:51 failed |
|  | 10-20 12:23 break ↑ grade 3 basis 3 |
|  | 10-20 12:28 failed |
|  | 10-20 12:44 break ↑ grade 0 basis 3 |
|  | 10-20 12:45 failed |
|  | 10-20 13:31 break ↓ grade 3 basis 3 |
|  | 10-20 13:34 failed |
|  | 10-20 13:49 break ↑ grade 0 basis 3 |
|  | 10-20 13:50 failed |
|  | 10-20 13:58 break ↑ grade 3 basis 3 |
|  | 10-20 14:03 held outside |
|  | 10-20 14:56 break ↑ grade 2 basis 3 |
|  | 10-20 15:00 failed |
|  | 10-20 15:12 break ↓ grade 3 basis 3 |
|  | 10-20 15:17 held outside |
|  | 10-20 19:23 break ↓ grade 3 basis 3 |
|  | 10-20 19:28 failed |
|  | 10-20 19:44 break ↑ grade 0 basis 3 |
|  | 10-20 19:49 held outside |
|  | 10-20 20:33 break ↑ grade 0 basis 3 |
|  | 10-20 20:38 held outside |
|  | 10-20 20:46 break ↑ grade 0 basis 3 |
|  | 10-20 20:51 held outside |
|  | 10-20 21:55 break ↑ grade 3 basis 3 |
|  | 10-20 21:57 failed |
|  | 10-20 23:07 break ↓ grade 3 basis 3 |
|  | 10-20 23:12 failed |
|  | 10-20 23:22 break ↓ grade 0 basis 3 |
|  | 10-20 23:27 held outside |
|  | 10-21 00:01 break ↓ grade 1 basis 3 |
|  | 10-21 00:02 failed |
|  | 10-21 00:15 break ↑ grade 3 basis 3 |
|  | 10-21 00:20 held outside |
|  | 10-21 00:51 break ↑ grade 3 basis 3 |
|  | 10-21 00:55 failed |
|  | 10-21 01:49 break ↑ grade 3 basis 3 |
|  | 10-21 01:54 held outside |
|  | 10-21 02:14 break ↓ grade 2 basis 3 |
|  | 10-21 02:16 failed |
|  | 10-21 03:08 break ↓ grade 0 basis 3 |
|  | 10-21 03:10 failed |
|  | 10-21 03:19 break ↓ grade 1 basis 3 |
|  | 10-21 03:21 failed |
|  | 10-21 03:32 break ↑ grade 1 basis 3 |
|  | 10-21 03:37 failed |
|  | 10-21 03:54 break ↓ grade 0 basis 3 |
|  | 10-21 03:59 held outside |
|  | 10-21 04:40 break ↓ grade 0 basis 3 |
|  | 10-21 04:45 failed |
|  | 10-21 05:01 break ↑ grade 3 basis 3 |
|  | 10-21 05:06 held outside |
|  | 10-21 05:41 break ↓ grade 3 basis 3 |
|  | 10-21 05:46 failed |
|  | 10-21 06:01 break ↓ grade 0 basis 3 |
|  | 10-21 06:03 failed |
|  | 10-21 06:21 break ↓ grade 0 basis 3 |
|  | 10-21 06:22 failed |
|  | 10-21 06:30 break ↑ grade 1 basis 3 |
|  | 10-21 06:35 held outside |
|  | 10-21 07:28 break ↑ grade 2 basis 3 |
|  | 10-21 07:33 held outside |
|  | 10-21 07:52 break ↑ grade 2 basis 3 |
|  | 10-21 07:56 failed |
|  | 10-21 08:45 break ↑ grade 2 basis 3 |
|  | 10-21 08:46 failed |
|  | 10-21 10:13 break ↓ grade 1 basis 3 |
|  | 10-21 10:18 held outside |
|  | 10-21 10:44 break ↑ grade 3 basis 3 |
|  | 10-21 10:47 failed |
|  | 10-21 10:56 break ↑ grade 0 basis 3 |
|  | 10-21 10:57 failed |
|  | 10-21 11:22 break ↑ grade 0 basis 3 |
|  | 10-21 11:27 held outside |
|  | 10-21 11:35 break ↓ grade 2 basis 3 |
|  | 10-21 11:36 failed |
|  | 10-21 11:49 break ↑ grade 0 basis 3 |
|  | 10-21 11:54 held outside |
|  | 10-21 13:01 break ↑ grade 3 basis 3 |
|  | 10-21 13:03 failed |
|  | 10-21 13:34 break ↓ grade 3 basis 3 |
|  | 10-21 13:39 failed |
|  | 10-21 14:47 break ↑ grade 3 basis 3 |
|  | 10-21 14:52 held outside |
|  | 10-21 15:04 break ↑ grade 3 basis 3 |
|  | 10-21 15:09 held outside |
|  | 10-21 15:33 break ↑ grade 2 basis 3 |
|  | 10-21 15:35 failed |
|  | 10-21 16:39 break ↑ grade 3 basis 3 |
|  | 10-21 16:40 failed |
|  | 10-21 18:51 break ↓ grade 3 basis 3 |
|  | 10-21 18:52 failed |
|  | 10-21 23:02 break ↓ grade 3 basis 3 |
|  | 10-21 23:07 held outside |
|  | 10-21 23:28 break ↓ grade 0 basis 3 |
|  | 10-21 23:30 failed |
|  | 10-21 23:44 break ↓ grade 2 basis 3 |
|  | 10-21 23:45 failed |
|  | 10-22 00:05 break ↑ grade 0 basis 3 |
|  | 10-22 00:10 held outside |
|  | 10-22 01:01 break ↓ grade 3 basis 3 |
|  | 10-22 01:03 failed |
|  | 10-22 01:38 break ↓ grade 3 basis 3 |
|  | 10-22 01:43 held outside |
|  | 10-22 02:05 break ↓ grade 0 basis 3 |
|  | 10-22 02:08 failed |
|  | 10-22 02:18 break ↓ grade 2 basis 3 |
|  | 10-22 02:23 held outside |
|  | 10-22 03:23 break ↓ grade 0 basis 3 |
|  | 10-22 03:25 failed |
|  | 10-22 03:43 break ↑ grade 0 basis 3 |
|  | 10-22 03:48 held outside |
|  | 10-22 04:00 break ↑ grade 3 basis 3 |
|  | 10-22 04:05 held outside |
|  | 10-22 04:38 break ↓ grade 1 basis 3 |
|  | 10-22 04:40 failed |
|  | 10-22 04:59 break ↑ grade 0 basis 3 |
|  | 10-22 05:04 failed |
|  | 10-22 05:15 break ↓ grade 3 basis 3 |
|  | 10-22 05:19 failed |
|  | 10-22 05:43 break ↓ grade 0 basis 3 |
|  | 10-22 05:48 held outside |
|  | 10-22 06:08 break ↑ grade 0 basis 3 |
|  | 10-22 06:09 failed |
|  | 10-22 06:45 break ↓ grade 0 basis 3 |
|  | 10-22 06:46 failed |
|  | 10-22 07:10 break ↓ grade 2 basis 3 |
|  | 10-22 07:11 failed |
|  | 10-22 08:02 break ↓ grade 3 basis 3 |
|  | 10-22 08:07 held outside |
|  | 10-22 08:23 break ↓ grade 0 basis 3 |
|  | 10-22 08:26 failed |
|  | 10-22 08:34 break ↓ grade 3 basis 3 |
|  | 10-22 08:39 held outside |
|  | 10-22 09:03 break ↓ grade 3 basis 3 |
|  | 10-22 09:06 failed |
|  | 10-22 10:01 break ↑ grade 3 basis 3 |
|  | 10-22 10:05 failed |
|  | 10-22 11:54 break ↓ grade 3 basis 3 |
|  | 10-22 11:59 held outside |
|  | 10-22 12:27 break ↑ grade 0 basis 3 |
|  | 10-22 12:30 failed |
|  | 10-22 13:06 break ↓ grade 3 basis 3 |
|  | 10-22 13:07 failed |
|  | 10-22 13:24 break ↑ grade 0 basis 3 |
|  | 10-22 13:26 failed |
|  | 10-22 13:52 break ↓ grade 0 basis 3 |
|  | 10-22 13:53 failed |
|  | 10-22 14:44 break ↑ grade 3 basis 3 |
|  | 10-22 14:45 failed |
|  | 10-22 15:10 break ↓ grade 2 basis 3 |
|  | 10-22 15:15 held outside |
|  | 10-22 16:41 break ↓ grade 0 basis 3 |
|  | 10-22 16:46 held outside |
|  | 10-22 19:32 break ↑ grade 2 basis 3 |
|  | 10-22 19:33 failed |
|  | 10-22 19:46 break ↓ grade 3 basis 3 |
|  | 10-22 19:48 failed |
|  | 10-22 20:49 break ↓ grade 1 basis 3 |
|  | 10-22 20:52 failed |
|  | 10-22 21:07 break ↑ grade 0 basis 3 |
|  | 10-22 21:12 held outside |
|  | 10-23 01:46 break ↑ grade 1 basis 3 |
|  | 10-23 01:48 failed |
|  | 10-23 02:31 break ↑ grade 3 basis 3 |
|  | 10-23 02:36 held outside |
|  | 10-23 02:57 break ↑ grade 3 basis 3 |
|  | 10-23 02:58 failed |
|  | 10-23 03:16 break ↓ grade 3 basis 3 |
|  | 10-23 03:21 held outside |
|  | 10-23 03:52 break ↑ grade 1 basis 3 |
|  | 10-23 03:53 failed |
|  | 10-23 04:04 break ↓ grade 0 basis 3 |
|  | 10-23 04:06 failed |
|  | 10-23 04:27 break ↓ grade 3 basis 3 |
|  | 10-23 04:32 held outside |
|  | 10-23 04:48 break ↓ grade 3 basis 3 |
|  | 10-23 04:53 held outside |
|  | 10-23 05:09 break ↑ grade 0 basis 3 |
|  | 10-23 05:11 failed |
|  | 10-23 05:42 break ↑ grade 0 basis 3 |
|  | 10-23 05:46 failed |
|  | 10-23 06:14 break ↑ grade 2 basis 3 |
|  | 10-23 06:19 held outside |
|  | 10-23 06:50 break ↑ grade 3 basis 3 |
|  | 10-23 06:52 failed |
|  | 10-23 07:15 break ↓ grade 3 basis 3 |
|  | 10-23 07:16 failed |
|  | 10-23 07:50 break ↓ grade 0 basis 3 |
|  | 10-23 07:55 held outside |
|  | 10-23 08:15 break ↑ grade 3 basis 3 |
|  | 10-23 08:20 held outside |
|  | 10-23 09:23 break ↓ grade 3 basis 3 |
|  | 10-23 09:28 held outside |
|  | 10-23 11:01 break ↓ grade 3 basis 3 |
|  | 10-23 11:03 failed |
|  | 10-23 11:42 break ↑ grade 3 basis 3 |
|  | 10-23 11:45 failed |
|  | 10-23 12:09 break ↓ grade 1 basis 3 |
|  | 10-23 12:14 held outside |
|  | 10-23 12:38 break ↑ grade 0 basis 3 |
|  | 10-23 12:43 failed |
|  | 10-23 13:15 break ↓ grade 1 basis 3 |
|  | 10-23 13:16 failed |
|  | 10-23 13:41 break ↑ grade 0 basis 3 |
|  | 10-23 13:46 held outside |
|  | 10-23 14:13 break ↓ grade 2 basis 3 |
|  | 10-23 14:14 failed |
|  | 10-23 22:47 break ↓ grade 3 basis 3 |
|  | 10-23 22:52 held outside |
|  | 10-23 23:49 break ↑ grade 2 basis 3 |
|  | 10-23 23:50 failed |
|  | 10-24 00:21 break ↓ grade 3 basis 3 |
|  | 10-24 00:22 failed |
|  | 10-24 00:35 break ↓ grade 0 basis 3 |
|  | 10-24 00:37 failed |
|  | 10-24 01:11 break ↑ grade 0 basis 3 |
|  | 10-24 01:12 failed |
|  | 10-24 01:30 break ↓ grade 3 basis 3 |
|  | 10-24 01:32 failed |
|  | 10-24 01:51 break ↑ grade 0 basis 3 |
|  | 10-24 01:56 held outside |
|  | 10-24 02:08 break ↑ grade 1 basis 3 |
|  | 10-24 02:11 failed |
|  | 10-24 03:01 break ↑ grade 1 basis 3 |
|  | 10-24 03:06 held outside |
|  | 10-24 03:48 break ↓ grade 1 basis 3 |
|  | 10-24 03:53 held outside |
|  | 10-24 05:18 break ↓ grade 1 basis 3 |
|  | 10-24 05:23 held outside |
|  | 10-24 07:02 break ↑ grade 3 basis 3 |
|  | 10-24 07:05 failed |
|  | 10-24 07:18 break ↑ grade 0 basis 3 |
|  | 10-24 07:20 failed |
|  | 10-24 07:31 break ↓ grade 3 basis 3 |
|  | 10-24 07:33 failed |
|  | 10-24 07:55 break ↓ grade 3 basis 3 |
|  | 10-24 08:00 held outside |
|  | 10-24 08:38 break ↓ grade 3 basis 3 |
|  | 10-24 08:39 failed |
|  | 10-24 09:03 break ↓ grade 3 basis 3 |
|  | 10-24 09:05 failed |
|  | 10-24 09:16 break ↓ grade 1 basis 3 |
|  | 10-24 09:21 held outside |
|  | 10-24 09:35 break ↓ grade 2 basis 3 |
|  | 10-24 09:40 failed |
|  | 10-24 09:51 break ↑ grade 3 basis 3 |
|  | 10-24 09:56 held outside |
|  | 10-24 10:31 break ↑ grade 0 basis 3 |
|  | 10-24 10:36 held outside |
|  | 10-24 12:02 break ↓ grade 2 basis 3 |
|  | 10-24 12:03 failed |
|  | 10-24 12:16 break ↑ grade 1 basis 3 |
|  | 10-24 12:21 held outside |
|  | 10-24 12:33 break ↑ grade 0 basis 3 |
|  | 10-24 12:34 failed |
|  | 10-24 12:47 break ↑ grade 2 basis 3 |
|  | 10-24 12:49 failed |
|  | 10-24 13:17 break ↓ grade 0 basis 3 |
|  | 10-24 13:22 held outside |
|  | 10-24 13:39 break ↓ grade 0 basis 3 |
|  | 10-24 13:40 failed |
|  | 10-24 13:53 break ↑ grade 2 basis 3 |
|  | 10-24 13:54 failed |
|  | 10-24 14:11 break ↓ grade 3 basis 3 |
|  | 10-24 14:16 held outside |
|  | 10-24 15:03 break ↓ grade 3 basis 3 |
|  | 10-24 15:08 held outside |
|  | 10-24 15:16 break ↓ grade 3 basis 3 |
|  | 10-24 15:21 held outside |
|  | 10-24 18:58 break ↑ grade 3 basis 3 |
|  | 10-24 18:59 failed |
|  | 10-24 20:00 break ↑ grade 3 basis 3 |
|  | 10-24 20:05 held outside |
|  | 10-24 21:07 break ↓ grade 3 basis 3 |
|  | 10-24 21:12 held outside |
|  | 10-24 23:04 break ↑ grade 0 basis 3 |
|  | 10-24 23:05 failed |
|  | 10-24 23:16 break ↓ grade 0 basis 3 |
|  | 10-24 23:19 failed |
|  | 10-24 23:31 break ↑ grade 3 basis 3 |
|  | 10-24 23:36 held outside |
|  | 10-25 00:48 break ↑ grade 3 basis 3 |
|  | 10-25 00:50 failed |
|  | 10-25 01:07 break ↓ grade 2 basis 3 |
|  | 10-25 01:12 held outside |
|  | 10-25 01:47 break ↑ grade 3 basis 3 |
|  | 10-25 01:52 failed |
|  | 10-25 02:06 break ↑ grade 0 basis 3 |
|  | 10-25 02:08 failed |
|  | 10-25 02:17 break ↓ grade 3 basis 3 |
|  | 10-25 02:18 failed |
|  | 10-25 02:36 break ↑ grade 0 basis 3 |
|  | 10-25 02:41 held outside |
|  | 10-25 03:55 break ↓ grade 0 basis 3 |
|  | 10-25 03:56 failed |
|  | 10-25 04:10 break ↑ grade 1 basis 3 |
|  | 10-25 04:12 failed |
|  | 10-25 04:21 break ↑ grade 3 basis 3 |
|  | 10-25 04:22 failed |
|  | 10-25 04:55 break ↑ grade 1 basis 3 |
|  | 10-25 04:56 failed |
|  | 10-25 05:23 break ↓ grade 1 basis 3 |
|  | 10-25 05:28 held outside |
|  | 10-25 06:04 break ↓ grade 1 basis 3 |
|  | 10-25 06:05 failed |
|  | 10-25 06:44 break ↓ grade 3 basis 3 |
|  | 10-25 06:46 failed |
|  | 10-25 08:28 break ↓ grade 3 basis 3 |
|  | 10-25 08:31 failed |
|  | 10-25 08:54 break ↓ grade 3 basis 3 |
|  | 10-25 08:55 failed |
|  | 10-25 09:12 break ↓ grade 3 basis 3 |
|  | 10-25 09:17 held outside |
|  | 10-25 11:44 break ↑ grade 3 basis 3 |
|  | 10-25 11:46 failed |
|  | 10-25 12:29 break ↓ grade 3 basis 3 |
|  | 10-25 12:30 failed |
|  | 10-25 13:11 break ↑ grade 0 basis 3 |
|  | 10-25 13:12 failed |
|  | 10-25 13:23 break ↓ grade 0 basis 3 |
|  | 10-25 13:28 held outside |
|  | 10-25 13:41 break ↑ grade 3 basis 3 |
|  | 10-25 13:42 failed |
|  | 10-25 14:50 break ↑ grade 3 basis 3 |
|  | 10-25 14:55 held outside |
|  | 10-25 15:39 break ↑ grade 3 basis 3 |
|  | 10-25 15:40 failed |
|  | 10-25 16:55 break ↑ grade 3 basis 3 |
|  | 10-25 17:00 held outside |
|  | 10-25 17:21 break ↑ grade 3 basis 3 |
|  | 10-25 17:24 failed |
|  | 10-25 19:06 break ↓ grade 3 basis 3 |
|  | 10-25 19:11 held outside |
|  | 10-25 19:28 break ↓ grade 3 basis 3 |
|  | 10-25 19:30 failed |
|  | 10-25 20:01 break ↓ grade 3 basis 3 |
|  | 10-25 20:06 held outside |
|  | 10-25 20:20 break ↑ grade 0 basis 3 |
|  | 10-25 20:22 failed |
|  | 10-25 20:44 break ↓ grade 3 basis 3 |
|  | 10-25 20:46 failed |
|  | 10-25 21:04 break ↓ grade 2 basis 3 |
|  | 10-25 21:05 failed |
|  | 10-25 21:23 break ↓ grade 0 basis 3 |
|  | 10-25 21:28 held outside |
|  | 10-25 21:45 break ↓ grade 3 basis 3 |
|  | 10-25 21:50 held outside |
|  | 10-25 23:26 break ↓ grade 3 basis 3 |
|  | 10-25 23:28 failed |
|  | 10-26 01:44 break ↓ grade 3 basis 3 |
|  | 10-26 01:48 failed |
|  | 10-26 02:42 break ↓ grade 0 basis 3 |
|  | 10-26 02:43 failed |
|  | 10-26 03:01 break ↑ grade 1 basis 3 |
|  | 10-26 03:06 held outside |
|  | 10-26 03:53 break ↓ grade 3 basis 3 |
|  | 10-26 03:54 failed |
|  | 10-26 04:11 break ↑ grade 0 basis 3 |
|  | 10-26 04:16 held outside |
|  | 10-26 04:52 break ↑ grade 2 basis 3 |
|  | 10-26 04:55 failed |
|  | 10-26 06:00 break ↑ grade 2 basis 3 |
|  | 10-26 06:01 failed |
|  | 10-26 06:23 break ↓ grade 1 basis 3 |
|  | 10-26 06:28 held outside |
|  | 10-26 07:00 break ↑ grade 3 basis 3 |
|  | 10-26 07:02 failed |
|  | 10-26 07:30 break ↓ grade 3 basis 3 |
|  | 10-26 07:31 failed |
|  | 10-26 07:43 break ↑ grade 3 basis 3 |
|  | 10-26 07:48 held outside |
|  | 10-26 08:02 break ↓ grade 1 basis 3 |
|  | 10-26 08:07 held outside |
|  | 10-26 08:27 break ↑ grade 1 basis 3 |
|  | 10-26 08:28 failed |
|  | 10-26 09:28 break ↑ grade 0 basis 3 |
|  | 10-26 09:30 failed |
|  | 10-26 09:46 break ↑ grade 0 basis 3 |
|  | 10-26 09:47 failed |
|  | 10-26 09:56 break ↑ grade 1 basis 3 |
|  | 10-26 09:59 failed |
|  | 10-26 10:59 break ↓ grade 0 basis 3 |
|  | 10-26 11:02 failed |
|  | 10-26 11:10 break ↓ grade 3 basis 3 |
|  | 10-26 11:15 held outside |
|  | 10-26 11:27 break ↑ grade 3 basis 3 |
|  | 10-26 11:29 failed |
|  | 10-26 11:39 break ↑ grade 0 basis 3 |
|  | 10-26 11:43 failed |
|  | 10-26 11:53 break ↑ grade 3 basis 3 |
|  | 10-26 11:58 held outside |
|  | 10-26 12:38 break ↓ grade 1 basis 3 |
|  | 10-26 12:43 held outside |
|  | 10-26 13:01 break ↓ grade 3 basis 3 |
|  | 10-26 13:03 failed |
|  | 10-26 13:21 break ↓ grade 0 basis 3 |
|  | 10-26 13:26 held outside |
|  | 10-26 13:56 break ↓ grade 0 basis 3 |
|  | 10-26 13:58 failed |
|  | 10-26 14:16 break ↑ grade 0 basis 3 |
|  | 10-26 14:17 failed |
|  | 10-26 15:00 break ↑ grade 0 basis 3 |
|  | 10-26 15:02 failed |
|  | 10-26 15:18 break ↑ grade 3 basis 3 |
|  | 10-26 15:23 held outside |
|  | 10-26 16:00 break ↓ grade 1 basis 3 |
|  | 10-26 16:01 failed |
|  | 10-26 16:14 break ↓ grade 0 basis 3 |
|  | 10-26 16:19 held outside |
|  | 10-26 16:28 break ↓ grade 0 basis 3 |
|  | 10-26 16:33 held outside |
|  | 10-26 17:00 break ↑ grade 3 basis 3 |
|  | 10-26 17:01 failed |

