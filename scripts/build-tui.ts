import { resolve } from "node:path";
import solidTransformPlugin from "@opentui/solid/bun-plugin";

// Optional paths let probes exercise the production pipeline on fixture sources.
const entrypoint = resolve(process.argv[2] ?? "./src/tui.tsx");
const outdir = resolve(process.argv[3] ?? "./dist");
const result = await Bun.build({
  entrypoints: [entrypoint],
  outdir,
  naming: "tui.js",
  target: "bun",
  plugins: [solidTransformPlugin],
  external: [
    "solid-js",
    "solid-js/*",
    "@opentui/core",
    "@opentui/core/*",
    "@opentui/solid",
    "@opentui/solid/*",
    "@opencode/plugin",
    "@opencode/plugin/*",
    "@opencode/theme",
    "@opencode/theme/*",
  ],
});
if (!result.success) throw new AggregateError(result.logs, "TUI build failed");
if (!await Bun.file(resolve(outdir, "tui.js")).exists()) {
  throw new Error("TUI build did not write dist/tui.js");
}
