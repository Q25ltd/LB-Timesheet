import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // 5173 / 4173 are the origins the API's development CORS allowlist already
  // names (`api/src/lib/env.schema.ts`). Pinned so a busy port fails loudly
  // instead of silently moving to an origin the API would refuse.
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
    restoreMocks: true,
  },
});
