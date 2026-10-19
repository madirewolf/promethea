import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` proxies the API to a backend started with `python -m promethea --headless --port 8090`.
const backend = process.env.PROMETHEA_BACKEND ?? "http://127.0.0.1:8090";

// With PROMETHEA_HOME set to that backend's data directory, the proxy signs requests with the
// instance's local token (re-read each time, since it changes on every start), so no login is needed.
function bearer(): string | null {
  const home = process.env.PROMETHEA_HOME;
  if (!home) return null;
  try {
    const { token } = JSON.parse(readFileSync(join(home, "instance.json"), "utf8")) as { token?: string };
    return token ? `Bearer ${token}` : null;
  } catch {
    return null;
  }
}

function sign(req: { removeHeader(name: string): void; setHeader(name: string, value: string): void }): void {
  // The dev server is a different origin; the backend refuses foreign Origin headers.
  req.removeHeader("origin");
  const auth = bearer();
  if (auth) req.setHeader("authorization", auth);
}

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../promethea/web",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: backend,
        changeOrigin: true,
        ws: true,
        configure: (proxy) => {
          proxy.on("proxyReq", sign);
          proxy.on("proxyReqWs", sign);
        },
      },
      "/auth": { target: backend, changeOrigin: true },
    },
  },
});
