# Cycle 1 research: market scan, underserved workflows, ranked concepts, positioning

Researcher seat. One bounded run, 2026-10-26. Everything below is tagged
**[verified]** (read on the cited page) or **[inferred]** (my judgment from
verified material). Reddit could not be fetched from this container (both
www and old.reddit.com blocked) and NexusFi/futures.io return 403; trader
complaints therefore come from Trustpilot, Elite Trader, Substack posts and
TradingView script pages. That is a sampling bias toward people motivated to
write a review; I note it where it matters.

## 1. Market scan

### 1.1 What competitors offer per data layer, and what they charge

| Product | Candles | Tape (L1) | Depth (L2) | Price (software only; exchange data extra everywhere) | Verification |
|---|---|---|---|---|---|
| Bookmap | standard charts | volume bubbles, CVD, iceberg/stop add-ons (MBO bundle) | the reference heatmap; crypto backfill 1 h / 24 h / 7 d by tier | Digital free (crypto); Global $49/mo or $39/mo annual or $990 lifetime; Global Plus $99/$79/$1,990; Global Premium $199/$158/$3,990; CME data from $34/mo per exchange | [verified] bookmap.com/pricing |
| ATAS | 240+ indicators | Smart Tape (rebuilds split prints), 400 footprint variants | Smart DOM with imbalance and "possible spoofing" columns | Start free; Plus EUR 24.95/mo; Pro EUR 69.95/mo; Ultra EUR 89.95/mo; lifetime EUR 999 to 1,999 | third-party review (completetradersedge), conflicting with other aggregators |
| Exocharts | pre-set candle types | footprint, volume profiles (Desktop Pro) | DOM on Desktop Pro only; Web has "no sessions, no DOM" | Web from $23/mo (6-month) to $28/mo; Desktop Pro $38 to $49/mo plus VAT; CME via dxFeed on Desktop only | [verified] exocharts.com |
| Jigsaw daytradr | basic | Reconstructed Tape, Auction Vista (adaptive "unusually heavy relative to recent" circles, "Fewer circles. Less noise.") | Depth & Sales DOM, pulling/stacking, iceberg | $579 one-time Foundation; $1,879 Institutional; $50/mo Active Trader Package for live broker trading | [verified] jigsawtrading.com/pricing |
| Sierra Chart | full | Numbers Bars (footprint) on "Advanced" packages | Market Depth Historical Graph (pkg 5/11), Market by Order (pkg 12) | $26 / $36 / $36 / $46 / $56 per month for packages 3/5/10/11/12 | pricingsaas.com snapshot Jun 2026 + damnpropfirms review |
| Quantower | full, Renko etc. in Advanced | Cluster chart, Power Trades ("large number of orders in a very short time"; free version clears after 3 min) | DOM Surface heatmap | All-in-One shows "70" per month with 10/20/30 percent discounts for 3/6/12 months; extensions sold separately, prices did not render | [verified] quantower.com/pricing, help.quantower.com |
| TensorCharts | basic | executed volume by price and side | browser order-book heatmap, liquidation context | free tier; Premium about $18 to $20/mo | third-party (NexusFi, tradingtoolshub, startupik) |
| TradingLite | basic | footprint cluster, volume profile | liquidity heatmap, LitScript | Silver $14.95/mo, Gold $24.95/mo, free trial | third-party (NexusFi listing); official site returned empty |
| Coinalyze | aggregated | aggregated CVD across 25 exchanges, 300+ tickers, OI, funding, liquidations | none | free ("all dashboards and tools are accessible free of charge"), optional paid | getblock.io write-up |
| Hyblock | basic | bid/ask delta widgets | liquidation and order-book heatmaps | Basic free; Advanced $69/mo annual; Professional $399/mo annual; no refunds | thegodfunded (checked 2026-10-09) |
| Velo | 1-minute history, 5+ years | derivatives metrics | none | free tier plus paid Pro; no public figure found | not verified |
| TradingView | the default for retail | built-in Volume Delta/CVD estimate delta from intrabar direction, not aggressor side | none (Pine is OHLCV only) | plans not re-checked; seconds-based intrabars need Premium per script authors | [verified] TradingView support 43000725058 |

[inferred] A retail trader wanting heatmap plus footprint plus data pays
roughly $60 to $150 per month, or $1,000 to $4,000 lifetime. Every product
sells the picture; none sells a verdict.

### 1.2 What traders praise

- Bookmap, 4.4/5 on 604 Trustpilot reviews: "truly the industry leader for the best heatmap in the industry" (Bollmann, Aug 2026); support praised repeatedly. [verified]
- Jigsaw's own positioning for Auction Vista, "Fewer circles. Less noise. More meaningful activity", shows the market leader in DOM training moving toward adaptive, relative thresholds rather than fixed sizes. [verified]
- TradingView's CVD help article is frank that "lower timeframes provide higher precision at the cost of less chart bar coverage"; traders value that honesty when they find it. [verified]

### 1.3 What traders complain about (quotes)

| Theme | Quote | Source |
|---|---|---|
| Heatmap walls read as S/R, then pulled | "most people think a heatmap is like a buy or sell wall so like support and resistance... most orders are spoofed so those heatmaps can be removed instantly therefore you can't trust those results." | Trustpilot, superfree apps, Dec 2025 |
| Same | "none of these levels act as support and resistance. People pull their orders and it breaks straight through." | Trustpilot, Kyle Hoey, Mar 2025 |
| Same | "It creates a false sense of support and resistance"; a resistance wall "vanished without warning." | Trustpilot, Turky Alhomdey, Dec 2025 |
| Resting size is not trustworthy, prints are | "Often times or almost at all times, the numbers in BID and ASK are fake and cannot be always trusted... The numbers however on the Trades column are always 100% legit." | tictoctrading.substack.com |
| Resting orders useless to intraday traders | "these are almost meaningless to intraday traders like myself... it's inherently beneficial to completely ignore the resting orders column when executing"; "Any other columns on the DOM are useless in my opinion unless you are looking for pulling/stacking" | faders.substack.com |
| Act only when price arrives | "a retail trader, imo, shouldn't be trading based on what is being offered or bid for several levels away... wait for price to get to those levels and find out if it is real or not." | Elite Trader, fortydraws, May 2015 |
| Detection too late | "Suspected spoofing events often only become apparent when observing the entire trend retrospectively... By the time it is identified, market participants have already been manipulated in their actions." | Cointelegraph Research |
| Real incident | 2,500 BTC (~$212M) sell order on Binance at $85,600 vanished as price approached, 14 Apr 2025; "Retail users won't stick around if they keep getting front-run, spoofed and dumped on." (Dr. Jan Philipp) | Yahoo Finance |
| Price and overload | "The pricing is honestly insane compared to newer competitors" (Bookmap); ATAS: "The learning curve is serious", "Occasional freezing on Windows", new users "routinely describe the first few days as overwhelming" | Trustpilot Piotr K., May 2026; completetradersedge ATAS review |
| It is just an order book | "nothing but an order book... Over priced and over hyped" | Trustpilot, James Jones, Sep 2026 |
| Beginners bounce off L2 | "It was extremely overwhelming at first, seeing flashing numbers and colors rip down my screen" | retailtradersrepository.substack.com |
| Volume-only breakout filters | "The number one complaint about opening range breakout systems is false breakouts... most false breakouts share a fingerprint: they happen on thin volume." and the counterpoint "Volume is one line item in it, not the whole verdict... plenty of real moves start without fanfare"; the actual requirement is "price acceptance beyond the level" | TradingView ORB script; LuxAlgo concept page |
| TradingView order flow is approximate | "TradingView Pine Script operates on OHLCV (Level 1) data... this indicator uses a heuristic model to approximate Order Flow dynamics"; footprint scripts "operate at the absolute edge of TradingView's rendering capabilities" (500-box limit) | TradingView scripts SeJ4Ng2g, 7oJyrrJO |
| Order flow as support, not system | "my use of order flow is secondary to price action, and acts as support" (Brooks guest post); "tape reading... in 2016 is a recipe for disaster" vs "Tape Reading has nothing to do with the way a HFT trades" (Elite Trader, 2016) | brookstradingcourse.com; Elite Trader |

Strongest single insight [inferred from the cluster above]: retail traders
do not fail because they lack depth data; they fail because the tools show
displayed liquidity as if it were a fact, and the trader learns the hard way
that **resting size is a claim and executed size is a fact**. The product
opportunity is to grade claims by what actually happened: did the wall get
hit or pulled, did volume move price, is this activity unusual for this
minute of the day.

## 2. Underserved workflows

| # | Decision the trader is making | Why current tools fail | What our platform has that they do not |
|---|---|---|---|
| W1 | "Price is at the range edge now: is this break real or a fake?" | TradingView filters are volume-only and confirm after the bar closes; heatmaps show the picture but leave the verdict to the trader; footprints bury the answer in numbers | candles with sided volume, tape with aggressor side, aggregated depth near price, all in one bar context |
| W2 | "A big wall sits above: will it hold when price arrives, or get pulled?" | heatmaps draw the wall; nothing tells you whether this market's walls usually hold, or whether this one is already shrinking as price approaches | `walls()` with `fill`, `eaten`, `endedBy`, `events()` with `wall_shrink` before touch |
| W3 | "Is this much activity normal for 09:35, or is something happening?" | plain RVOL compares against a rolling average, so every open looks unusual and every lunch looks dead | 10,080 retained 1m bars allow a same-minute-of-day baseline over prior sessions; works in Historical Mode |
| W4 | "Is it safe to execute right now (spread, flicker, thin top of book around news)?" | DOMs show it as flashing numbers; charts show nothing; the complaint "liquidity pulls and refreshes more aggressively" on NQ is folklore, not a measurement | top of book from the ladder every frame, 0.2 ms budget |
| W5 | "Buyers are hitting hard: is price actually going, or is someone absorbing?" | CVD lumps size classes; footprint overload; Exhaustion/Initiative on this platform judge legs after they form | tape with size, price change per unit of aggressor volume, live |
| W6 | "After the break: is price being accepted above the level or rejected?" | tools mark the break, not the acceptance; LuxAlgo and many traders say acceptance is the actual requirement | candles (any mode) plus optional sided volume beyond the level |
| W7 | "Can I trust what I am looking at in replay?" | TradingView's CVD silently changes precision with intrabar timeframe; crypto heatmap backfill is 1 h on free tiers | explicit Historical policies and `tradeAvailability`; honesty is a feature |

## 3. Ranked concepts

Ordered by usefulness times feasibility on this platform. "Hist" means works
in Historical Mode under an existing policy. Data terms follow the capability
sheet. Registry overlap is checked against the 44 shipped ids.

### Ranking table

| Rank | Concept | Layer | Data | Hist | Confidence | Biggest risk |
|---|---|---|---|---|---|---|
| 1 | Relative Volume by Time of Day | candles | candles | yes | high | needs enough same-weekday sessions; crypto 24h vs equity RTH baselines differ |
| 2 | Breakout Verdict (cross-layer) | candles + tape + aggregated depth | candles, tape, `l2.ladder()`/`events()` | OHLCV part only; L1/L2 lights null in replay | medium | combined score must be explained and validated per component (charter rule) |
| 3 | Liquidity Ahead of Price (pull/stack as price approaches) | depth | aggregated depth, `l2.events()` | no (verified Aug 2026 hours only) | medium-high | Binance aggregated depth hides individual cancels; must be framed as observation |
| 4 | Price Response per Aggressive Volume | tape (+ candles fallback) | tape with side; candle range and sided volume in fallback | fallback yes, flagged approximate | high | unit scaling across BTC/ES/AAPL; equities have 35 to 75 percent unsided prints |
| 5 | Breakout Acceptance Meter | candles | candles (+ sided volume where present) | yes | high | level definition; must not repaint the level |
| 6 | Wall Reliability Scorecard | depth | `l2.walls()` evidence (`fill`, `eaten`, `endedBy`, lifetime) | `l2_walls` verified hours | medium | small samples in quiet hours; needs minimum-N gating |
| 7 | Spread and Top-of-Book Stability | top of book | `l2.ladder()` best bid/ask per frame | no | high | trivially cheap; risk is being dismissed as a utility rather than an indicator |
| 8 | Tape Speed with Bursts | tape | `ticks` store, `coverageOf` | no | medium-high | burst thresholds must be time-of-day relative or they fire all open |
| 9 | Session Volume Pace | candles | candles | yes | high | projection claims are predictive; keep to "pace vs typical" |
| 10 | CVD Split by Trade Size | tape | tape with side and size | no | medium | size-class cutoffs per instrument; overlaps Large Trade Detector marks |
| 11 | Replenishment After a Wall is Eaten | depth | `l2.events()` `wall_trade`/`wall_end`, `ladder()` | no | medium | distinguishing reload from unrelated new orders on aggregated depth |
| 12 | Compression Age | candles | candles | yes | high | TTM Squeeze exists in `ta.*`; must add duration/percentile context or it is a rename |
| 13 | Bar-Averaged Book Imbalance | depth | `l2.ladder()` top N levels | no | medium | the most copied metric in competitors; noisy; weak differentiation |
| 14 | Market Sweep Detector | tape | tape across prices within ms | no | low-medium | Flowprint Blocks and Aggressive Orders already show fast pushes and big prints |

### Concept details

**1. Relative Volume by Time of Day** (candles). Target: ES/NQ and equity
day traders, Binance scalpers. Question: "is this volume unusual for this
minute?" Problem: rolling-average RVOL flags every open and nothing at lunch.
Differentiation: competitors' RVOL and the TradingView scripts that fix it
(ORB Volume Confirmation, Pineify) are candle-only on TradingView data; here
it also feeds the Breakout Verdict and runs identically live and historical.
Registry: nothing computes relative volume; this is the baseline the charter
asks every volume tool to beat. Default view: one histogram in its own pane,
1.0 line, bars above 2x highlighted. Pitch: "Volume that knows what time it
is." Confidence high. Risk: baseline depth (needs 10 to 20 prior sessions at
1m; 10,080 bars is 7 days of 24h crypto, 27 RTH days of equities).

**2. Breakout Verdict** (cross-layer). Target: breakout traders on ES/NQ and
BTC perps. Question: "this bar is breaking the range: did volume, trade
response and nearby liquidity confirm it?" Problem: W1. Calculation sketch:
(a) compression from candles (Bollinger/Keltner width percentile, range
age); (b) break = close beyond range high/low; (c) three lights at the break:
Volume = concept 1 above threshold; Response = concept 4 shows price moving
per unit of aggressive volume above its recent median (not absorbed);
Liquidity = concept 3 shows depth ahead of price thinning or pulling rather
than stacking. Each light is its own validated component; the verdict is a
count of lights, not a weighted score. Differentiation: Bookmap, ATAS and
Quantower show all three facts on three panels and leave the synthesis to
the trader; TradingView can only do (a) and a weaker (c)-less (b). Registry:
Session Levels grades killzone levels by what the book did when price came
to them, the nearest relative; this concept grades the break itself, in the
bar, for any range. Default view: a marker on the breaking bar with three
small lights and a one-line label ("3/3: volume, response, liquidity");
compression shading before it. Historical Mode: shows the volume light
only and says so. Pitch: "Three facts at the moment of the break, not a
feeling." Confidence medium. Risk: overclaiming; must ship as descriptive
("what confirmed") until forward observation earns a predictive claim.

**3. Liquidity Ahead of Price** (depth). Target: anyone who has been burned
by a pulled wall. Question: "as price approaches, is the book ahead of it
thinning (pulling) or thickening (stacking)?" Problem: W2, the single most
repeated complaint. Calculation: displayed size within N ticks ahead of the
last price versus 10 to 30 s earlier and versus size behind; `wall_shrink`
events on the near side before any fill are counted as pulls. Differentiation:
ATAS has a "possible spoofing" column on the DOM; Bookmap teaches "if you see
large orders pulling before prices reach them" as a manual read. Nobody puts
the pull/stack state in the price pane as a continuous read. Registry:
Absorption marks walls that held after being hit; Whale Limit Order Heatmap
and L2 S&R show walls; Empty Orderbook shows thin rows. None measures change
ahead of price before contact. Default view: two thin bands just above and
below price, coloured by thinning/stacking, with a legend word. Pitch: "See
the wall leave before you lean on it." Confidence medium-high. Risk: on
Binance aggregated depth, a shrink could be a fill elsewhere or a cancel;
report as observation, never intent.

**4. Price Response per Aggressive Volume** (tape, candle fallback). Target:
scalpers and anyone reading CVD. Question: "is aggression moving price, or
being absorbed?" Problem: W5. Calculation: ticks moved per unit of signed
aggressor volume over a rolling window; low value with high volume reads as
absorption, high value with low volume as a thin book. Candle fallback: bar
range per sided volume, flagged "approximate" in the legend. Differentiation:
Exhaustion and Initiative on this platform judge legs after a zigzag forms;
VPIN Cloud is toxicity, not response. Bookmap's "trade impact" lives inside
Jigsaw's DOM, not on a chart. Default view: one line in its own pane with a
median band; dips below the band while CVD rises are highlighted. Pitch:
"Effort versus result, one line." Confidence high. Risk: equities with 35 to
75 percent unsided prints need an "unsided share" readout.

**5. Breakout Acceptance Meter** (candles). Target: swing and intraday
breakout traders, all markets. Question: "after the break, is price being
accepted beyond the level?" Problem: W6. Calculation: bars, time and volume
spent beyond the broken level versus returned inside, over a fixed number of
bars after the break; shows a filling bar. Differentiation: TradingView ORB
scripts stop at the breakout candle; LuxAlgo argues acceptance is the real
test but sells no measure of it. Registry: Market Structure marks BOS/CHoCH
events only. Default view: a small horizontal gauge at the level filling from
0 to 100 percent acceptance. Pitch: "Breakouts are confirmed by what happens
next; this shows it." Confidence high. Risk: level definition must be fixed
at break time (no repaint).

**6. Wall Reliability Scorecard** (depth). Target: heatmap users on NQ, ES,
BTC. Question: "in this market, right now, how often do walls hold when
touched?" Problem: W2 and the W7 trust gap; the base rate is unknown to the
trader. Calculation: from `walls()` evidence over the last 2 to 4 hours:
share filled vs pulled before touch (`endedBy`), median lifetime, median
`fill` ratio; by side. Differentiation: no competitor publishes this base
rate; Bookmap's Trustpilot critics are describing its absence. Registry:
Whale Limit Order Heatmap shows wall cards one at a time; nothing aggregates.
Default view: a four-cell table top right ("Bid walls: 62 percent held (n=21)
· Ask walls: 38 percent held (n=16)"). Pitch: "Know how honest this book has
been today before you trust a wall." Confidence medium. Risk: small samples;
gate at n >= 10 and say so.

**7. Spread and Top-of-Book Stability** (top of book). Target: NQ and BTC
scalpers, news traders. Question: "are execution conditions normal right
now?" Problem: W4. Calculation: spread in ticks, best bid/ask size relative
to the hour's median, changes of best price per second. Differentiation: a
DOM shows it as flicker; no chart product plots it as a condition light.
Registry: L2 Feed Status reports feed health, not market conditions. Default
view: a thin strip under the price pane, green/amber/red, with the spread
number. Pitch: "A traffic light for the book before you click." Confidence
high. Risk: perceived as a utility; pairs well as the fourth light of
concept 2.

**8. Tape Speed with Bursts** (tape). Target: scalpers on BTC and NQ.
Question: "is participation accelerating right now?" Calculation: prints per
second against the same-minute baseline from the tick store, burst markers
when speed exceeds k times baseline. Differentiation: Jigsaw's Auction Vista
and Quantower's Power Trades sell exactly this inside paid add-ons; here it
is on the chart. Registry: Large Trade Detector and Aggressive Orders are
size-based; this is count-based and catches algorithmic slicing that hides
size ("algorithms split large orders into small clips"). Default view: own
pane line with burst dots. Pitch: "Speed of the tape, not just size."
Confidence medium-high. Risk: live-only, honest nulls in replay.

**9. Session Volume Pace** (candles). "Is today a participation day?"
Cumulative session volume versus the median cumulative at the same clock time
over prior sessions, one line around 1.0. Coinalyze and Velo show totals, not
same-time pace; Session Profile here is by price, not time. Pitch: "Is anyone
here today?" Risk: do not project end-of-day volume; that is a prediction.

**10. CVD Split by Trade Size** (tape). Crypto perp traders asking "are
large or small aggressors driving this?" Two cumulative lines, large and
small, in one pane. Aggressive Order Flow draws one CVD and Large Trade
Detector marks prints; nothing shows the split. Pitch: "Who is actually
buying." Risk: size cutoffs per instrument; live-only.

**11. Replenishment After a Wall is Eaten** (depth). "When the level traded
through, did size come back?" Time to recover x percent of eaten size at the
same or next level; markers "reloaded in 4 s" / "no reload". Practitioners
endorse "reloading" as the one DOM read worth having; no chart product plots
it. Iceberg Detector covers same-order refills, not the level after a wall
ends. Risk: attribution on aggregated depth.

**12. Compression Age** (candles). Duration percentile and range position of
the current coil; shading deepens with age. `ta.ttmSqueeze` exists only as a
factory. Pitch: "How wound is the spring." Low differentiation unless folded
into concept 2.

**13. Bar-Averaged Book Imbalance** (depth). Every competitor has it and
traders call it noise; keep as the baseline concept 3 must beat.

**14. Market Sweep Detector** (tape). Flowprint Blocks and Aggressive Orders
already cover fast pushes and big prints; marginal.

Combining advice for the PM: 1, 4, 3 and 7 are the components of 2; build
1 first (cheap, historical, the agreed baseline), then 2 as the cycle-1
flagship with 5 as its post-break companion.

## 4. Positioning

How to describe the lineup to retail traders: **tools that grade claims by
what actually happened.** Displayed liquidity is a claim; executed volume is
a fact; a breakout is a claim until price is accepted. Each indicator says
which it is showing, and what the baseline is.

| Safe to claim now | Claim only after validation earns it |
|---|---|
| "Shows volume relative to the same minute of the day over the last N sessions" | "Filters out false breakouts" |
| "Shows whether displayed depth ahead of price thinned or thickened in the last 30 s" | "Detects spoofing" or any statement of intent |
| "Shows how often walls were filled versus pulled in this session" | "Walls that score X hold Y percent of the time" (needs an unseen period) |
| "Shows ticks moved per unit of aggressive volume" | "Identifies absorption before reversals" |
| "Three facts at the break: volume, response, liquidity; replay shows only the first and says so" | Any combined confidence percentage |
| "Same value live and in replay, or the difference is stated" | "Backtested edge" of any kind |

Tone rules [inferred from complaints]: never use "support and resistance"
for a wall; say "resting size". Never hide approximation: the TradingView
CVD article is respected because it states the precision trade-off. Price
against Bookmap Global ($39 to $49/mo) plus data: our story is not "another
heatmap" but "the read the heatmap left to you".

## 5. Sources

- Bookmap pricing: https://bookmap.com/pricing
- Bookmap Trustpilot (overall and 1-star filter): https://nz.trustpilot.com/review/bookmap.com ; https://www.trustpilot.com/review/bookmap.com?stars=1
- Bookmap on spoofing: https://bookmap.com/blog/what-is-spoofing-in-trading
- Bookmap NQ page: https://bookmap.com/content/instruments/nq
- ATAS review with EUR prices and drawbacks: https://completetradersedge.com/atas-review/
- ATAS pricing (aggregators, conflicting): https://nexusfi.com/d/platforms/atas ; https://tradingtoolshub.com/blog/atas-pricing-guide-2026/
- Exocharts official: https://exocharts.com/ ; review: https://tradingtoolshub.com/review/exocharts/
- Jigsaw pricing and Auction Vista: https://www.jigsawtrading.com/pricing/
- Sierra Chart prices: https://pricingsaas.com/companies/sierrachart ; packages: https://damnpropfirms.com/trading-guides/sierra-chart-review-pricing-packages-data-feeds/
- Quantower pricing and licenses: https://www.quantower.com/pricing ; https://help.quantower.com/quantower/getting-started/quantower-licenses
- TensorCharts: https://nexusfi.com/d/platforms/tensorcharts ; https://tradingtoolshub.com/review/tensorcharts/ ; https://startupik.com/tensorcharts-review-order-flow-and-heatmaps-for-serious-traders/
- TradingLite pricing (listing): https://nexusfi.com/d/platforms/tradinglite/
- Coinalyze: https://getblock.io/blog/coinalyze-track-and-monitor-crypto-markets/
- Hyblock pricing: https://thegodfunded.com/en/tools/hyblock/
- Velo (competitor comparison, unverified): https://www.sharpe.ai/compare/sharpe-vs-velo ; https://openbb.co/blog/velo-brings-digital-assets-market-data-to-OpenBB/
- TradingView CVD support article: https://in.tradingview.com/support/solutions/43000725058-cumulative-volume-delta/
- TradingView scripts: Volume Footprint https://www.tradingview.com/script/7oJyrrJO/ ; Cumulative Volume Delta https://www.tradingview.com/script/DPZytr7C-Cumulative-Volume-Delta/ ; Bookmap-Style Aggressor Bubbles https://www.tradingview.com/script/SeJ4Ng2g-Bookmap-Style-Aggressor-Bubbles ; ORB Volume Confirmation https://www.tradingview.com/script/CEhSfPK2-ORB-Volume-Confirmation-AlphaScript/ ; RVOL https://www.tradingview.com/script/XbEe8hjF-Relative-Volume-RVOL-JopAlgo
- LuxAlgo, Volume at Breakout: https://www.luxalgo.com/library/concept/volume-at-breakout.md
- Trader practice and complaints: https://faders.substack.com/p/orderflow-dynamics ; https://tictoctrading.substack.com/p/an-introduction-to-the-tape ; https://retailtradersrepository.substack.com/p/level-2-data-inexperienced-traders-disregard
- Elite Trader threads: https://www.elitetrader.com/et/threads/futures-trading-analysis.291387/post-4122466 ; https://www.elitetrader.com/et/threads/impossible-tape-trader.304013/post-4353697
- Brooks Trading Course on order flow: https://www.brookstradingcourse.com/pt-br/?p=60032
- Cointelegraph Research on spoofing and liquidity maps: https://cointelegraph.com/research/crypto-market-spoofing-identifying-fake-orders-and-their-impact
- Yahoo Finance, vanishing $212M order: https://finance.yahoo.com/news/vanishing-212m-bitcoin-order-caused-130604349.html
- Not reachable from this container (cited by search snippets only): https://nexusfi.com/showthread.php?p=840007 ; https://nexusfi.com/showthread.php?p=574960 ; https://futures.io/platforms-indicators/56821-bookmap-motivewave-rithmic-issue.html ; reddit.com

## Summary (ten lines)

1. Top concept: Relative Volume by Time of Day, the cheap historical baseline every volume claim must beat.
2. Flagship: Breakout Verdict, three validated lights (volume, response, liquidity) on the breaking bar.
3. Liquidity Ahead of Price turns the number-one heatmap complaint (pulled walls) into a continuous read.
4. Price Response per Aggressive Volume shows absorption as effort versus result, with an honest candle fallback.
5. Breakout Acceptance Meter measures what traders say actually confirms a break: acceptance beyond the level.
6. Competitors sell pictures ($15 to $200/mo, $1k to $4k lifetime) and leave interpretation to the trader.
7. Trader complaints cluster on one failure: resting size shown as fact, read as support, then pulled.
8. The strongest insight: resting size is a claim, executed size is a fact; grade claims by outcomes.
9. Safe claims are descriptive and baseline-relative; "filters fakeouts" and "detects spoofing" need validation.
10. Reddit and NexusFi were unreachable here; complaint evidence is Trustpilot, Elite Trader and Substack.
