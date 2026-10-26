# UX standard for new indicators (cycle 1)

Written by the UX seat from the code in `Terminal-L1-L2-development-indicator-sdk`
(snapshot 2026-10-26) and from rendered charts (`PM/cycle1/screenshots/`).
Code wins over this page; report a disagreement to the PM. The rules in
part 2 are what every new indicator must follow; part 1 is what the house
already does, so a new indicator looks like it belongs.

## 1. House conventions observed

### 1.1 Colours

| Where | Value | Source |
|---|---|---|
| Live chart (default, light) | background `#f2efe6`, up candle `#f8f8f5` with `#111111` stroke, down candle `#111111` | `CHART_PALETTE`, `ChartPanel.tsx` |
| Dark chart (Historical Mode, `.shell.historical-active`) | background `#111316`, up `#36d684`, down `#f16a72`, text `#9ca3af` | `DARK_CHART_PALETTE`, `App.css` |
| UI tokens | `--bull #4ade80`, `--bear #f87171`, `--warn #fbbf24` (dark page); `--bull #0e9a66`, `--bear #c23854`, `--warn #b07a1e`, `--accent #0e9a93` (light page) | `index.css` |
| Existing indicator lines | RSI `#4d3d78`; SMA purple `#8672b3`, blue `#2563eb`, green `#16a34a`; CVD up `#16a34a`, down `#dc2626`; CVD on dark `#facc15`; reference lines `rgba(10,10,10,0.3)` | `rsi.ts`, `sma.ts`, `INDICATOR_PALETTE` |
| Marker default | `#787b86`, shapes `circle`, `square`, `arrowUp`, `arrowDown` | `draw/markers.ts` |
| Table overlay | `rgba(10,10,10,0.82)` background, `#f8f8f5` text, mono 11 px, top-right (or bottom-right) | `.draw-table-overlay`, `draw/table.ts` |

The candles are monochrome on the default chart, so green and red are free
for meaning: buyers, sellers, bull, bear. Hand-wired lines use
`INDICATOR_LINE_WIDTH = 2`; an SDK line takes `lines[].lineWidth` and falls
back to 2. SDK line series are created with `lastValueVisible: false` and
`priceLineVisible: false`, so an SDK line has no current-value label on the
price axis; own-pane `priceLines` do get dotted 1 px lines with axis labels
(`ChartPanel.tsx`, runtime series creation).

### 1.2 Legend rows

Top-left stack over the chart, one white pill per indicator
(`IndicatorLegendRow`): mono 11 px bold label, an optional grey `detail`, and
eye / gear / trash buttons that appear on hover or focus. In Historical Mode
the pill is dark. The label is the registry `label` (`"RSI (14)"`, so the
default parameter is in the name). The detail is set per indicator by hand
in `MainPanel.tsx`; a generic SDK indicator with a `settingsSchema` gets label
and gear only. Observed detail strings: `Swing 20`, `≥ 5 ct`,
`Bar volume × typical price`, `Live only · 20 bars required`,
`Warming · ≥ 0.50z`, ` · history unavailable`, `waiting for the book`,
`reconnecting`, `loading the view's prints`.

### 1.3 Settings dialog

`IndicatorSettingsModal` is a draggable fixed panel about 320 px wide, title
bar with the indicator label and a close button, body, footer with
**Reset to default**, **Defaults ▾** (presets) and **Ok**. Edits apply live;
Ok only closes. The generic body (`GenericIndicatorSettingsBody`) stacks
fields vertically, label above control; sliders show the value inline
(`Inner band (σ) 1.00`); tabs **Inputs** / **Visibility** appear only when a
field declares `tab`. Hand-built dialogs (Aggressive Orders, the heatmap)
copy the same tab strip and classes. Every dialog has presets for free from
its schema (`docs/architecture/indicators/setting-presets.md`).

### 1.4 Copy tone

Sentence case labels with the unit in brackets: `Session length`,
`Lookback (bars)`, `Show orders larger than (BTC)`. Hints are plain full
sentences that say what the control does and what it costs:
"Changing the anchor, the session length or a band width replays every bar."
Legend details and status strings are short lowercase phrases after ` · `.
Status chips: `LIVE`, `SYNCING`, `STALE`, `QUIET`, `HISTORY ONLY`,
`Feed unavailable`, `Live profile catching up`, `VPIN waiting for trades`,
`Analytics incomplete — reload to rebuild`. Numbers are mono and tabular.

### 1.5 How indicators signal warm-up, degraded and unavailable today

- An SDK indicator returns `null` from `readOutput` until it has enough bars:
  the line simply starts later (RSI draws nothing for its first 14 bars).
  Nothing tells the trader it is warming up.
- Hand-wired indicators put state in the legend detail (`Warming ·`,
  `Unavailable ·`, `history unavailable`, `waiting for the book`) or in a
  status chip. The data rule is "warm-up failure is not an empty signal";
  never draw a zero or a flat line for data you do not have
  (`data-for-indicator-authors.md`, Rules).
- A throw, a non-finite number or a non-string colour latches a fault: the
  indicator goes blank until removed and re-added, with no message in the
  legend. Fail closed to `null` instead.
- Historical Mode greys out indicators whose policy says unavailable and
  shows the `unavailableReason` sentence.

## 2. The standard every new indicator follows

### 2.1 Default view: readable in three seconds

1. One question, one primary mark. The first thing on screen is the series,
   band or marker that answers the indicator's question. Secondary context
   (a baseline, a threshold) is thinner and lighter.
2. At most two lines and one fill at default settings. A third series goes
   behind a Visibility toggle, off by default.
3. Pane or overlay: a value in price units (a level, a band, a VWAP) is an
   `overlay`. A bounded ratio, score or oscillator is an `ownPane` with
   `priceLines` at its decision levels and a fixed `autoscaleRange`, so the
   pane does not rescale as the trader scrolls. Do not share a pane unless
   the two indicators are read together.
4. Line widths: primary 2, secondary 1. Fills between 0.12 and 0.25 alpha.
5. It must read on both charts: the cream live chart and the dark Historical
   chart. Take a screenshot of each before handing over (section 4).
6. The registry `label` carries the default parameter, as `RSI (14)` does,
   so the legend explains itself.

### 2.2 Controls: at most three primary, the rest Advanced

- Inputs tab: at most three controls without a `tab` (or `tab: "inputs"`).
  These are the ones a trader changes in the first session: the length,
  the threshold, the mode.
- Everything else that changes the calculation: `tab: "advanced"`. The
  generic dialog renders it as a closed **Advanced** group at the end of the
  Inputs tab (prototype on the UX branch, see
  `PM/cycle1/advanced-settings-proposal.md`; until merged, keep the list of
  advanced keys in the README and leave them off the schema's first screen).
- Colours, show/hide toggles, opacity, labels: `tab: "visibility"`.
- Prefer `slider` or `select` with named stops over free `numeric` boxes;
  a numeric field needs `step > 0` or the generic dialog refuses every value.
- One explanatory paragraph at most on the Inputs tab; a one-line hint per
  control is fine. The full explanation lives in the indicator's README.
- Use the generic dialog. A hand-built dialog needs a PM decision.
- Settings that depend on the instrument (a size floor) use
  `settingsFieldsFor` for the suggested value, never a provider branch in
  the schema.

### 2.3 Colour semantics

- Green/red (`--bull`/`--bear`, or the candle-up/down colours on the dark
  chart) only for direction or side: buying vs selling, above vs below.
- A non-directional series takes one neutral colour from the house set:
  purple `#4d3d78` / `#8672b3`, blue `#2563eb`, amber `#facc15` (dark chart
  only). Never introduce a new hue for a single indicator.
- Thresholds and reference lines: `rgba(10,10,10,0.3)` on the cream chart,
  `rgba(250,250,247,0.32)` on the dark one.
- Warning or "degraded" state: `--warn`, never red (red means sell).
- Expose a colour in Visibility only when the trader could plausibly need
  to change it; the default must already be right.

### 2.4 Markers

- At most two event types per indicator, one shape each: `arrowUp` below the
  bar and `arrowDown` above it for directional events, `circle` for neutral.
- `text` at most three characters; prefer none.
- Density: at default settings on a 1m BTC chart, no more than about one
  marker per ten bars on average. If the fixture shows more, raise the
  default threshold; the trader can lower it under Advanced.
- Marker colour equals the colour of the line or side it belongs to.
- Markers never replace the line: a marker says "here", the series says "why".

### 2.5 "Alert conditions" without an alert system

There is no notification channel. An alert condition is:

1. a named, documented condition in the README under **Alert conditions**
   (name, exact rule, which bar it fires on, how often it fires on the
   fixture);
2. a marker on the bar where it fires (section 2.4);
3. a row in the indicator's own `draw.table` (top-right): condition name,
   the bar time and the value, for example `Squeeze fired · 12:34 · 1.8σ`.
   A generic SDK indicator cannot write to the legend detail today, so the
   table is the place.

Never promise a notification in copy. Use the condition's name
("Squeeze fired"), not the word "alert", in anything the trader reads.

### 2.6 First use: before warm-up completes

- Draw nothing for bars without a value (`null`), never a zero or a flat
  line, never a partial window as if it were full.
- While warming up, the table shows one row: `Warming up · 37 of 200 bars`.
  When data the indicator needs is not there (ticks in replay, L2 before
  the first frame, a timeframe outside the gate), the row says what it needs
  in the trader's terms: `Needs live trades`, `Needs 1m to 15m`,
  `Waiting for the book`. Remove the row once the indicator is live.
- State the warm-up length in the README and keep it under the chart's
  retention (`maxReplayBars`, at most 10,080 1m bars).
- Replay honesty: a value the replay cannot compute (tick-only inputs) is
  `null`, and the README says that history looks different from live.

### 2.7 Tooltips and hover: what can and cannot be promised

Only hand-wired indicators have hover today: `fvgDelta` and `sessionLevels`
through `getHoverData` in `ChartPanel.tsx`, and the Aggressive Orders bubbles
and the heatmap through their own primitives. A new SDK indicator gets no
tooltip without a chart-pipeline change and PM approval. Therefore:

- Design so nothing essential needs a hover: an SDK line has no price-axis
  value label, so the current value and the state go in the table, and
  thresholds are drawn as `priceLines` (which do get axis labels).
- You may implement `getHoverData` for later wiring, but the README must not
  claim a tooltip, and the screenshots must not show one.

### 2.8 Copy for labels and hints

- Labels: sentence case, at most four words, unit in brackets:
  `Lookback (bars)`, `Minimum size (BTC)`.
- Hints: one or two sentences, present tense, say what changes and whether
  it replays ("Replays every bar").
- Use the feed vocabulary from `CAPABILITIES.md`: top of book, aggregated
  depth, tape, candles. Say "estimate" when it is one; never "detects" or
  "predicts" unless validation established it.
- Legend detail and table cells: at most 30 characters, ` · ` between parts,
  numbers tabular.
- Status phrases are lowercase and concrete: `waiting for the book`, not
  `Initializing…`.

## 3. Handover checklist (UX)

- [ ] Default view screenshots at two zoom levels, cream and dark chart
- [ ] Inputs tab shows at most three controls; Advanced group holds the rest
- [ ] Every settings key is in the schema; presets work (test enforces)
- [ ] Warm-up row visible on first use; nothing drawn as zero
- [ ] Markers under the density cap on the fixture
- [ ] README has: question answered, default view, controls, alert
      conditions, warm-up length, what replay cannot show, no tooltip claim

## 4. Producing screenshots in this container

Binance is not reachable from the container (the runtime's startup fails
after 30 s: `binance_connection.route_error` for every route, then
`lifecycle.start_failed reason market data server: required routes never
reached CONNECTED within 30000ms`). Use the fixture runtime, which speaks
the frame contract and renders the real web app:

```sh
export PATH=/root/.nvm/versions/node/v24.21.0/bin:$PATH
cd <your worktree>                       # with node_modules linked as in the brief
cp -n .env.example .env
# 1. fixture runtime on 8001 (the Vite proxy's default target)
REPO=/home/user/Terminal-L1-L2/Terminal-L1-L2-development-indicator-sdk \
  node /home/user/Terminal-L1-L2/PM/cycle1/screenshots/tools/fixture-ws-server.cjs 8001 900 7 &
# 2. web app on 8000
npm run dev --workspace web &
# 3. screenshots: default, <indicator> zoomed out/in, <dialog indicator> Inputs/Visibility
node /home/user/Terminal-L1-L2/PM/cycle1/screenshots/tools/screenshot.cjs \
  /home/user/Terminal-L1-L2/PM/cycle1/screenshots/<indicator> "<legend label>" "<legend label with dialog>"
```

The fixture sends `selection`, `snapshot` (900 synthetic closed 1m BTC-USDT
spot bars, a random walk with slow regimes), `health` READY, a two-level
`book`, then a forming `bar` revised every second. Snapshot bars must all be
`closed: true` and on the minute, or the browser drops the frame
(`parseSnapshotFrame` in `types/frames.ts`). Tick-, L2- and heatmap-driven
indicators get no data from it; extend the fixture with `trade` and
`liquidity` frames from `frames.ts` when you need them, or state that the
screenshot is OHLCV-only. For the dark chart, switch to Historical Mode in
the UI (needs layer 1) or set `data-theme="dark"` on `<html>` in the script.
Zoom is done with the mouse wheel over `.chart-mount`; the legend row's
gear opens the dialog; `getByRole("tab", { name: "Visibility" })` switches
tabs. Playwright and Chromium are preinstalled; never run
`playwright install`. Stop both servers when done.
