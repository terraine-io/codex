import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";

const OUT_DIR = 'dist';

// Ensure dist directory exists
if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

console.log('Building WebSocket server and context manager...');

// Build context managers (strategy-based system)
await esbuild
  .build({
    entryPoints: ["context-managers.ts"],
    bundle: true,
    format: "esm",
    platform: "node", 
    tsconfig: "tsconfig.json",
    outfile: `${OUT_DIR}/context-managers.js`,
    sourcemap: true,
    external: ["ws"], // Keep ws as external dependency
    inject: ["./require-shim.js"],
  })
  .catch((error) => {
    console.error('Failed to build context-managers:', error);
    process.exit(1);
  });

// Build WebSocket server
await esbuild
  .build({
    entryPoints: ["ws-server.ts"],
    bundle: true,
    format: "esm", 
    platform: "node",
    tsconfig: "tsconfig.json",
    outfile: `${OUT_DIR}/ws-server.js`,
    sourcemap: true,
    external: ["ws"], // Keep ws as external dependency
    inject: ["./require-shim.js"],
  })
  .catch((error) => {
    console.error('Failed to build ws-server:', error);
    process.exit(1);
  });

console.log('✅ WebSocket server build completed!');
console.log(`Output files:`);
console.log(`  - ${OUT_DIR}/context-managers.js`);
console.log(`  - ${OUT_DIR}/ws-server.js`);