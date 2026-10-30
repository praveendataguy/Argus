import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": { target: "http://localhost:8787", changeOrigin: true }, "/.well-known": "http://localhost:8787", "/mcp": "http://localhost:8787" } },
});
