import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = "http://127.0.0.1:8787";

// `--mode pages` arma el sitio estático (GitHub Pages): sin server, con rutas relativas.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === "pages" ? "./" : "/",
  worker: { format: "es" },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": server,
      "/ws": { target: server, ws: true },
    },
  },
}));
