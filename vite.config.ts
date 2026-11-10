import { readFileSync } from "node:fs";
import { defineConfig } from "vite-plus";
export default defineConfig({
  pack: {
    entry: { plugin: "src/plugin.ts" },
    banner: `/*!\n${readFileSync(new URL("./NOTICE", import.meta.url), "utf8").replace(/\r\n/g, "\n")}*/`,
    outDir: "dist",
    format: "esm",
    platform: "node",
    target: "node24",
    deps: { alwaysBundle: () => true, onlyBundle: false },
  },
});
