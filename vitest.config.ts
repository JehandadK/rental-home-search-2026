import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: import.meta.dirname,
    // Scripts hold the source-data parsers, so they are covered too; tools holds the architecture test.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts", "tools/**/*.test.ts"],
  },
});
