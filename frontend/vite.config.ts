import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API = process.env.SPORTS_API ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.SPORTS_WEB_PORT ?? 5173),
    // Only /api/* and the exact /health probe go to the backend. The Health page lives at /stats
    // (a bare /health is the probe everywhere: Caddy, compose healthchecks, smoke.sh).
    proxy: { "/api": { target: API, changeOrigin: false }, "^/health$": API },
  },
  // Never inline assets as data: URIs; the CSP allows fonts and scripts from self only.
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
});
