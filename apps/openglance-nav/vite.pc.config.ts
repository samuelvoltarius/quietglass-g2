import { defineConfig } from "vite";

/**
 * The PC route planner (planner.html), built on its own into dist-pc/ so that
 * nothing of it (map library included) ends up in the glasses package.
 * Served by the route store: `ROUTES_WEB=<dist-pc>` in routes_server.py.
 */
export default defineConfig({
  base: "./",
  server: { host: "127.0.0.1", port: 5198 },
  build: {
    target: "es2022",
    outDir: "dist-pc",
    emptyOutDir: true,
    rollupOptions: { input: "planner.html" },
  },
});
