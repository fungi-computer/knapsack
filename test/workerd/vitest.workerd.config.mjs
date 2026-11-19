import { resolve } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: resolve(import.meta.dirname, "../.."),
  plugins: [
    cloudflareTest({
      main: "./test/workerd/probe.worker.mjs",
      remoteBindings: false,
      miniflare: {
        compatibilityDate: "2026-09-02",
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
  test: {
    include: ["test/workerd/*.workerd.test.mjs"],
  },
});
