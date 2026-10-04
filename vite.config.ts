import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative URLs everywhere, so the built site works from any sub-path
  // (e.g. https://example.com/rentals/) with no rebuild.
  base: "./",
  server: { port: 5173 },
});
