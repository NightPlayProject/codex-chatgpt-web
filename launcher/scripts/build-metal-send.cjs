const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const entrypoint = path.join(launcherRoot, "wallpapers", "metal-send.tsx");
const outfile = path.join(launcherRoot, "wallpapers", "metal-send.bundle.js");

async function main() {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "browser",
    format: "iife",
    minify: true,
    sourcemap: "none",
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const output = result.outputs.find(item => item.kind === "entry-point") || result.outputs[0];
  if (!output) throw new Error("Metal send-button build returned no output");
  await Bun.write(outfile, output);
  if (!fs.existsSync(outfile) || fs.statSync(outfile).size < 1024) {
    throw new Error("Metal send-button bundle was not generated");
  }
  console.log(`Built ${path.relative(launcherRoot, outfile)} (${fs.statSync(outfile).size} bytes)`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
