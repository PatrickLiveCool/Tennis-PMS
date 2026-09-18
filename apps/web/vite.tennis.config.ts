import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const proxy = {
  "/api": { target: "http://127.0.0.1:4200", changeOrigin: true },
  "/health": { target: "http://127.0.0.1:4200", changeOrigin: true },
};
export default defineConfig({
  root,
  plugins: [
    react(),
    {
      name: "tennis-entry",
      configureServer(server) {
        server.middlewares.use((request, _reply, next) => {
          if (request.url === "/" || request.url?.startsWith("/?")) request.url = "/tennis.html" + request.url.slice(1);
          next();
        });
      },
      generateBundle: {
        order: "post",
        handler(_options, bundle) {
          const page = bundle["tennis.html"];
          if (page) {
            delete bundle["tennis.html"];
            page.fileName = "index.html";
            bundle["index.html"] = page;
          }
        },
      },
    },
  ],
  server: { host: "127.0.0.1", port: 4273, strictPort: true, proxy },
  preview: { host: "127.0.0.1", port: 4273, strictPort: true, proxy },
  build: {
    outDir: "dist-tennis",
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL("tennis.html", import.meta.url)) },
  },
});
