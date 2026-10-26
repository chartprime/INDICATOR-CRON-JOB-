# Terminal Web

React/TypeScript frontend for the local L1/L2 terminal. A dedicated
worker owns the WebSocket connection, validates every server frame,
reconnects with bounded backoff, and forwards confirmed market data to
the chart, tape, and DOM ladder.

Run commands from the repository root so the workspace uses the single
canonical root lockfile:

```powershell
npm install
npm run dev --workspace web
npm run test --workspace web
npm run build --workspace web
```

The development UI binds to `http://127.0.0.1:8000` and proxies `/ws`
and `/health` to the runtime on `127.0.0.1:8001`.
