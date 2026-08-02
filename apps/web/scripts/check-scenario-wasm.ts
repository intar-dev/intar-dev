import { access } from "node:fs/promises";

const requiredFiles = [
  "src/generated/scenario-wasm/intar_image_scenario_wasm.d.ts",
  "src/generated/scenario-wasm/intar_image_scenario_wasm.js",
  "src/generated/scenario-wasm/intar_image_scenario_wasm_bg.wasm",
  "src/generated/scenario-wasm/intar_image_scenario_wasm_bg.wasm.d.ts",
];

const missingFiles: string[] = [];
for (const file of requiredFiles) {
  try {
    await access(file);
  } catch {
    missingFiles.push(file);
  }
}

if (missingFiles.length > 0) {
  console.error(
    [
      "The browser scenario Wasm build artifact is missing.",
      "Run `just generate-scenario-wasm` from the repository root.",
      "CI builds this artifact automatically; generated files stay ignored.",
      ...missingFiles.map((file) => `- ${file}`),
    ].join("\n"),
  );
  process.exit(1);
}
