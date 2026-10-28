// Clipboard store mutation-order regressions. Loads the real store through
// Vite SSR with a controllable IPC mock (no Tauri window required).

import { createServer } from "vite";

const behavior = {
  pauseFails: true,
  clearDelayMs: 40,
  clearFails: false,
  deleteFails: false,
  restoreFails: true,
};
const events = [];
const toasts = [];
globalThis.window = globalThis;
window.__LUME_CONFIG__ = { appearance: {}, clipboard: {} };
window.setTimeout = setTimeout;
window.clearTimeout = clearTimeout;
globalThis.document = { documentElement: { lang: "" }, getElementById: () => null, querySelector: () => null };
window.__TAURI_INTERNALS__ = globalThis.__TAURI_INTERNALS__ = {
  invoke: async (cmd, args) => {
    events.push({ cmd, args });
    if (cmd === "set_clipboard_paused") {
      if (behavior.pauseFails) throw new Error("mock pause failure");
      return args.paused;
    }
    if (cmd === "clear_clipboard") {
      await new Promise((resolve) => setTimeout(resolve, behavior.clearDelayMs));
      if (behavior.clearFails) throw new Error("mock clear failure");
      return 1;
    }
    if (cmd === "delete_clipboard") {
      if (behavior.deleteFails) throw new Error("mock delete failure");
      return { id: args.id, kind: "text", content: "row", created_at: Date.now(), pinned: false, source_app: "", html: null, merged_count: 1, path: null, checked: null };
    }
    if (cmd === "restore_clipboard") {
      if (behavior.restoreFails) throw new Error("mock restore failure");
      return null;
    }
    if (cmd === "search_clipboard") {
      return {
        items: [{ id: 1, kind: "text", content: "row", created_at: Date.now(), pinned: false, valid: true, has_html: false, merged_count: 1 }],
        total: 1,
        categories: { all: 1, text: 1, textfile: 0, image: 0, music: 0, video: 0, favorites: 0 },
      };
    }
    return null;
  },
};

const server = await createServer({
  configFile: false,
  appType: "custom",
  clearScreen: false,
  logLevel: "error",
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});

const checks = [];
const check = (name, ok, extra = "") => {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
};

try {
  const { createClipboardStore } = await server.ssrLoadModule("/src/plugins/clipboard/store.ts");
  const searches = [];
  const services = {
    showToast: (text) => toasts.push(text),
    markEntryOpened: () => {},
    resetAndHide: () => {},
    runSearch: async (q) => { searches.push(q); },
    persistLastPage: () => {},
    searchToken: () => 1,
    nextSearchToken: () => 2,
    selectionSource: () => "other",
    markMouse: () => {},
    openMenu: () => {},
    mode: () => "clipboard",
    requestMode: () => {},
    setModePlaceholder: () => {},
    setSubInput: () => {},
    subInputOwner: () => null,
    enterPlugin: () => true,
    detachMode: () => {},
    setPluginColorMode: async () => {},
    pluginColorState: () => ({ pref: "system", mode: "dark", host: "dark", skin: "quiet", accent: "" }),
    scheduleResize: () => {},
    setQuery: () => {},
    resizeWindow: () => {},
    dragWindow: () => {},
  };
  const store = createClipboardStore(services);

  await store.search("");
  check(
    "search consumes backend category counts and the active-category total",
    store.categoryCounts().textfile === 0 && store.categoryTotal() === 1 && store.clips().length === 1,
    JSON.stringify({ counts: store.categoryCounts(), total: store.categoryTotal() }),
  );

  await store.toggleClipPause();
  check("pause failure leaves recording visibly enabled", store.clipPaused() === false && toasts.includes("无法更改剪贴板记录状态。"), JSON.stringify({ paused: store.clipPaused(), toasts }));

  behavior.clearDelayMs = 60;
  store.setClearOpen(true);
  const clearPromise = store.doClear();
  await new Promise((resolve) => setTimeout(resolve, 20));
  check("clear refresh waits for the backend", searches.length === 0 && store.clearOpen() === true, JSON.stringify({ searches, open: store.clearOpen() }));
  await clearPromise;
  check("clear success closes the dialog and refreshes", searches.length === 1 && store.clearOpen() === false, JSON.stringify({ searches, open: store.clearOpen() }));

  behavior.clearFails = true;
  const searchesBeforeFailure = searches.length;
  store.setClearOpen(true);
  await store.doClear();
  check("clear failure keeps the dialog open and skips refresh", store.clearOpen() === true && searches.length === searchesBeforeFailure, JSON.stringify({ searches, open: store.clearOpen(), toasts }));

  store.setClips([{ id: 1, kind: "text", content: "row", created_at: Date.now(), pinned: false, valid: true, has_html: false, merged_count: 1 }]);
  behavior.deleteFails = true;
  await store.deleteItem(1);
  check("delete failure keeps the row and reports it", store.clips().length === 1 && toasts.includes("无法删除该剪贴板条目。"), JSON.stringify({ rows: store.clips().length, toasts }));

  behavior.deleteFails = false;
  await store.deleteItem(1);
  check("delete success creates an undo buffer", store.undoBuf()?.id === 1, JSON.stringify(store.undoBuf()));
  await store.undoDelete();
  check("undo failure keeps the buffer retryable and reports it", store.undoBuf()?.id === 1 && toasts.includes("无法恢复该剪贴板条目。"), JSON.stringify({ undo: store.undoBuf(), toasts }));

  console.log(`\nCLIPBOARD STORE UNIT ${checks.every((item) => item.ok) ? "PASS" : "FAIL"} (${checks.filter((item) => item.ok).length}/${checks.length})`);
  if (!checks.every((item) => item.ok)) process.exitCode = 1;
} finally {
  await server.close();
}