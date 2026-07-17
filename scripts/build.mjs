import { build } from "esbuild";
import { rm } from "node:fs/promises";

// Prevent globally installed packages from changing the dependency graph.
delete process.env.NODE_PATH;
await rm("dist/index.cjs.map", { force: true });

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: "dist/index.cjs",
  minify: true,
});