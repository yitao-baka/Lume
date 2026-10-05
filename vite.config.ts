import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [solid()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
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
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // Multi-page build: the satellite preview window loads its own tiny page
  // (preview.html → src/preview.tsx) and detached plugin windows their own
  // (plugin.html → src/pluginWindow.tsx), so the prod bundle must emit all.
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        preview: "preview.html",
        plugin: "plugin.html",
        // P6.5 逻辑宿主窗口 + 每插件逻辑帧（共享窗口内的沙箱 iframe 页）
        pluginLogic: "pluginLogic.html",
        pluginLogicFrame: "pluginLogicFrame.html",
      },
    },
  },
}));
