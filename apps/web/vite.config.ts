import { defineConfig } from "vite";

// @vitejs/plugin-react@6 requires vite@^8 (imports vite/internal).
// Vite 7's built-in esbuild JSX transform handles react-jsx without the plugin.
export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
  build: {
    outDir: "dist",
  },
});
