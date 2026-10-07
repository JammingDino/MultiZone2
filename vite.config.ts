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
    // The app's own entry is ~1.7 MB; mermaid, which used to set this at 3.5 MB,
    // now loads per diagram type in chunks well under it. Just above the entry,
    // so a genuinely new oversized chunk still warns.
    chunkSizeWarningLimit: 2000,
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
        // the "content" chunk.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          // pdfjs and mermaid are not listed: both are dynamic imports now
          // (lib/pdf.ts, MermaidBlock.tsx), loaded on the first PDF or diagram.
          // A manual chunk for either pulled the modules mermaid shares with
          // the app into that chunk, and with them the whole 2.9 MB into the
          // startup preload list.
          if (id.includes("/katex/")) return "katex";
          // Prism grammars load per language (PrismAsyncLight). Matching them
          // below as "refractor" would fold all ~300 back into the startup chunk.
          if (id.includes("/refractor/lang/") || id.includes("/async-languages/")) return;
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
