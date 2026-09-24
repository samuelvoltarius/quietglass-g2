import { defineConfig } from "vite";

export default defineConfig({
  server: { host: "127.0.0.1", port: 5199 },
  build: { target: "es2022", outDir: "dist" },
});
