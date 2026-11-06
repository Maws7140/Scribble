import esbuild from "esbuild";
import { builtinModules } from "node:module";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  format: "cjs",
  target: "es2020",
  platform: "node",
  outfile: "main.js",
  logLevel: "info",
});
