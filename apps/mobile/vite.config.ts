import { defineConfig } from "vite";

export default defineConfig({
  // The simulator shares the Mac's network stack, so `pnpm sim:dev` points the
  // app at this server on localhost. Fixed port so the shell knows where to look;
  // 5174 stays clear of desktop's 1420 and Vite's default 5173.
  server: { port: 5174, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
