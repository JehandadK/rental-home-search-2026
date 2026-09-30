import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: import.meta.dirname,
    // scripts/ holds CLI tests; tools/ holds the architecture test.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts", "tools/**/*.test.ts"],
  },
});
