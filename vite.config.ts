import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "path";

export default defineConfig({
  plugins: [
    tanstackStart({
      server: { entry: "src/start.ts" },
    }),
    react(),
    tailwindcss(),
    tsconfigPaths({ projects: ["./tsconfig.json"] }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  optimizeDeps: {
    exclude: ["@tensorflow/tfjs-node", "tfjs-node", "tensorflow"],
  },
  server: {
    host: "0.0.0.0",
    port: 5000,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/binance-rest": {
        target: "https://api.binance.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/binance-rest/, ""),
        secure: true,
      },
      "/binance-ws": {
        target: "wss://stream.binance.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/binance-ws/, ""),
        ws: true,
        secure: true,
      },
      "/api/rl": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
