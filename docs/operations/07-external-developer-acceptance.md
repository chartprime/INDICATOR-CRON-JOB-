# External developer handoff acceptance

[Handbook](../README.md) · [Onboarding](00-developer-onboarding.md) ·
[Access](02-developer-access.md) · [Data for indicator authors](../architecture/indicators/data-for-indicator-authors.md)

Run this after documentation, access or topology changes, with a developer who
was not part of the work. It tests whether they can reach a working terminal
and build on it from the repository and their issued access alone, without
roadmap reports or private chat. Every question they have to ask is a
documentation defect: record it and fix the page. This checklist does not
replace a provider or production soak.

## Layer 0 · Repository only

- [ ] From the root README alone, explain the three access layers and which
      ones this developer has.
- [ ] Install Node 24.21.0, run `npm ci --ignore-scripts`, and create `.env` from `.env.example`
      without editing any other file.
- [ ] `npm run doctor` passes with layers 1 and 2 reported *not configured*.
- [ ] Terminal C (`npm run dev` in `apps/runtime`) and Terminal D
      (`npm run dev --workspace web`) start, and Live Mode shows Binance.
- [ ] Historical Mode states that it needs host data access, and a dxFeed
      instrument shows `History only · dxFeed live not configured`.
- [ ] `npm run check` passes.

## Layer 1 · Host data

- [ ] The developer sends only a name and a WireGuard public key; the owner
      issues access with `developer-access.sh` and sends the tunnel settings in
      chat and the bearer through a one-time secret link.
- [ ] With the tunnel up and the bearer in both `.env` lines, `npm run doctor`
      reports layer 1 *working*.
- [ ] Historical Mode charts ES Continuous at 1h, and a volume profile appears.
- [ ] AAPL shows an order-flow indicator with its unsided share stated.
- [ ] A live Binance chart warms up from the host (the runtime logs a remote
      warm-up) while `/ws` and `/health` stay on the laptop.
- [ ] With the tunnel switched off, `doctor` blames WireGuard; with one wrong
      character in the bearer, `doctor` blames the bearer.

## Layer 2 · dxFeed live

Only for a developer granted Tailscale broker access.

- [ ] With `TT_DXFEED_TOKEN_BROKER_URL` set, Terminal C's banner says dxFeed is
      available on select, and selecting ES streams live data.
- [ ] Switching away ends the session.

## Building an indicator

- [ ] Using only the [author page](../architecture/indicators/data-for-indicator-authors.md),
      say which of an indicator's inputs exist live, in warm-up and in
      Historical Mode for BTC, ES and AAPL.
- [ ] Explain why sell volume is read through `barSides` rather than computed
      as `volume - buy_volume`, and what `missing` and `empty` each mean.
- [ ] Add a trivial indicator, register it with a Historical Mode policy, and
      see it in both modes.

## Owner side

- [ ] `developer-access.sh list` shows the developer with a recent handshake.
- [ ] `revoke` removes both the peer and the bearer; `doctor` on the laptop then
      fails at WireGuard.
- [ ] The operator can find the server runbook's service inventory, the
      change-to-action matrix and the developer-access section without help.

Record the date, the developer, the repository revision, the host release, and
every failed item or question asked. Do not mark a network or provider item
complete from a mocked or repository-only test.
