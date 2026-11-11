import { build } from "esbuild";

const common = { bundle: true, platform: "node", target: "node22", sourcemap: false, logLevel: "info", external: ["electron"] };

await build({ ...common, entryPoints: ["electron/main.ts"], outfile: "dist-electron/main.mjs", format: "esm" });
// sandboxed preload scripts must be CommonJS
await build({ ...common, entryPoints: ["electron/preload.ts"], outfile: "dist-electron/preload.cjs", format: "cjs" });
