import { build } from "esbuild";
import { rm } from "node:fs/promises";

// Prevent globally installed packages from changing the dependency graph.
delete process.env.NODE_PATH;
await rm("dist", { force: true, recursive: true });

await build({
  entryPoints: ["src/lib.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: "dist/lib.cjs",
  minify: true,
});

const sharedLibraryPlugin = {
  name: "shared-library",
  setup(build) {
    build.onResolve({ filter: /^\.\/lib$/ }, () => ({
      path: "./lib.cjs",
      external: true,
    }));
  },
};

await Promise.all([
  build({
    entryPoints: ["src/action-entrypoint.ts"],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    outfile: "dist/action.cjs",
    minify: true,
    plugins: [sharedLibraryPlugin],
  }),
  build({
    entryPoints: ["src/cli-entrypoint.ts"],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    outfile: "dist/cli.cjs",
    minify: true,
    plugins: [sharedLibraryPlugin],
  }),
]);