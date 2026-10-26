import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer, createServerModuleRunner } from "vite";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node run.mjs <folder of *.json liquidity stores>");
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const server = await createServer({ root, configFile: false, logLevel: "error", server: { middlewareMode: true, ws: false, hmr: false } });
try {
  const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
  const { main } = await runner.import("/src/lib/indicators/institutional-order-blocks-v2/calibration/calibrateCli.ts");
  main(resolve(dir));
} finally {
  await server.close();
}
