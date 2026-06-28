import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [
    react(),
    tailwindcss(),
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
          dest: ".",
        },
      ],
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  build: {
    // mermaid alone is ~2.9 MB minified and can't be split further; this
    // threshold sits just above it so genuinely new oversized chunks still warn.
    chunkSizeWarningLimit: 3500,
    rollupOptions: {
      output: {
        // Split heavy vendor libraries into their own chunks so the main
        // bundle stays well under the chunk-size warning threshold and these
        // rarely-changing deps cache independently.
        //
        // katex is a shared leaf: both the markdown/content ecosystem (via
        // rehype-katex) and mermaid depend on it. Isolating it in its own
        // chunk that everyone imports one-way keeps the dependency graph
        // acyclic. Crucially it's matched as "/katex/" so the bridge module
        // rehype-katex (which pulls in the hast/unist web) stays in "content"
        // instead of dragging that web into the katex chunk and forming a
        // cycle. markdown + syntax highlighting are coupled enough to share
        // the "content" chunk; pdfjs and mermaid are self-contained.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (id.includes("pdfjs-dist")) return "pdfjs";
          if (id.includes("/katex/")) return "katex";
          if (id.includes("/mermaid/") || id.includes("@mermaid-js"))
            return "mermaid";
          if (
            id.includes("react-markdown") ||
            id.includes("remark") ||
            id.includes("rehype") ||
            id.includes("micromark") ||
            id.includes("mdast") ||
            id.includes("hast") ||
            id.includes("unist") ||
            id.includes("unified") ||
            id.includes("react-syntax-highlighter") ||
            id.includes("refractor") ||
            id.includes("highlight.js") ||
            id.includes("lowlight") ||
            id.includes("prismjs")
          )
            return "content";
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
