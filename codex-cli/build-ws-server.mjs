import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";

console.log('Building WebSocket server...');

// Build WebSocket server
await esbuild.build({
  entryPoints: ["ws-server.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  tsconfig: "tsconfig.json",
  outfile: "dist/ws-server.js",
  minify: false,
  sourcemap: true,
  external: ["ws"], // Keep ws as external dependency
  inject: ["./require-shim.js"],
}).catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});

console.log('WebSocket server built successfully at dist/ws-server.js');