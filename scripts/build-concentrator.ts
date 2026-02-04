#!/usr/bin/env bun
/**
 * Build script for concentrator
 * Creates a single executable
 */

import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const OUT_FILE = join(ROOT, "bin", "concentrator");

async function build() {
  console.log("[build] Building concentrator...");

  const result = await Bun.build({
    entrypoints: [join(ROOT, "src", "concentrator", "index.ts")],
    compile: {
      outfile: OUT_FILE,
    },
    minify: true,
  });

  if (!result.success) {
    console.error("[build] Failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  console.log(`[build] Created ${OUT_FILE}`);

  // Show file size
  const stat = await Bun.file(OUT_FILE).stat();
  const sizeMB = (stat?.size || 0) / 1024 / 1024;
  console.log(`[build] Size: ${sizeMB.toFixed(2)} MB`);
}

build();
