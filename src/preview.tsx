/**
 * Satellite preview window (ROADMAP #15).
 *
 * All clipboard previews render here instead of the launcher renderer, so a
 * decoded 4K bitmap or buffered video never lingers in the main window. The
 * window is created once at startup (hidden), docked flush to the launcher's
 * right edge, and non-activating (`WS_EX_NOACTIVATE` — clicking it never
 * steals focus from the launcher). Closing tears the page down to `about:blank`
 * (frees the decoded resources; the renderer process stays for reuse).
 *
 * The payload (`PreviewRequest`) comes from the Rust side: read once on mount
 * via `get_preview_request`, then live-updated via the `preview-update` event
 * (selection changes don't reload the page — no flicker). Esc / close handling
 * lives in the MAIN window (a non-activating window never receives keys); the
 * × button here is the in-window close affordance.
 *
 * PDF preview (ROADMAP #14, PDF.js): `pdfjs-dist` is imported lazily so the
 * ~MB library only loads into this renderer on the first PDF preview. Only the
 * visible page is rendered (canvas re-drawn on page/zoom change) and previous
 * docs are destroyed, so a giant PDF never pins the whole document in memory.
 */
import { render } from "solid-js/web";
import { createSignal, createEffect, onMount, Show, Switch, Match, For } from "solid-js";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { t, setLocale, resolveLocale } from "./i18n";
import "./preview.css";

/** Mirrors the Rust `PreviewRequest` (window.rs). */
interface PreviewRequest {
  kind: "text" | "textfile" | "image" | "audio" | "video" | "pdf" | "filelist";
  content: string | null;
  path: string | null;
  id: number | null;
  /** Multi-file rows (`filelist`): every recorded path. */
  paths?: string[] | null;
  /** Stored checked-file indices (`filelist`); null = no override. */
  checked?: number[] | null;
  /** 记住勾选 at request time — the toggle state shown in the list header. */
  remember_checks?: boolean;
}

/** Last path segment (handles both `/` and `\` separators). */
function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** A rendered multi-file list: paths + per-path existence + checked indices. */
interface FileListState {
  paths: string[];
  exists: boolean[];
  checked: Set<number>;
  remember: boolean;
}

function PreviewApp() {
  const [req, setReq] = createSignal<PreviewRequest | null>(null);
  const [text, setText] = createSignal<string | null>(null);
  const [imgSrc, setImgSrc] = createSignal<string | null>(null);
  const [poster, setPoster] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  /** "contain" fits the image; clicking toggles to "one-one" (natural size). */
  const [fit, setFit] = createSignal<"contain" | "one-one">("contain");
  /** Multi-file list (ROADMAP #17): paths + existence + checked indices. */
  const [filelist, setFilelist] = createSignal<FileListState | null>(null);

  /** Toggle a file's checkbox. Persists only while 记住勾选 is on. */
  function toggleFile(idx: number, on: boolean) {
    const fl = filelist();
    if (!fl) return;
    const checked = new Set(fl.checked);
    if (on) checked.add(idx);
    else checked.delete(idx);
    setFilelist({ ...fl, checked });
    if (fl.remember) {
      void invoke("set_clipboard_checked", {
        id: req()?.id,
        checked: [...checked],
      }).catch(() => {});
    }
  }

  /** Flip the 记住勾选 toggle; turning it off resets checks to "every existing
   * file" (the next session starts fresh there). */
  function toggleRemember(on: boolean) {
    const fl = filelist();
    if (!fl) return;
    setFilelist({ ...fl, remember: on });
    void invoke("set_remember_checks", { enabled: on }).catch(() => {});
    if (!on) {
      const checked = new Set(fl.paths.map((_, i) => i).filter((i) => fl.exists[i]));
      setFilelist((f) => (f ? { ...f, checked } : f));
    }
  }

  // ── PDF (PDF.js) state ───────────────────────────────────────────────────
  const [pdfDoc, setPdfDoc] = createSignal<PDFDocumentProxy | null>(null);
  const [pdfPage, setPdfPage] = createSignal(1);
  /** Zoom multiplier; 1 = fit the page width to the window. */
  const [pdfScale, setPdfScale] = createSignal(1);
  const [pdfError, setPdfError] = createSignal<string | null>(null);
  let pdfCanvas: HTMLCanvasElement | undefined;
  let pdfRenderToken = 0;
  let pdfRenderTask: { cancel(): void } | null = null;

  /** Render the current page into the canvas. Only the visible page exists as
   * a raster; switching pages / zooming re-renders. Stale async renders are
   * cancelled + dropped via `pdfRenderToken` so rapid paging stays coherent. */
  async function drawPdfPage() {
    const doc = pdfDoc();
    const pageNo = pdfPage();
    if (!doc || !pdfCanvas) return;
    const token = ++pdfRenderToken;
    if (pdfRenderTask) {
      pdfRenderTask.cancel();
      pdfRenderTask = null;
    }
    const page = await doc.getPage(pageNo).catch(() => null);
    if (!page || token !== pdfRenderToken) return;
    const dpr = window.devicePixelRatio || 1;
    const vp1 = page.getViewport({ scale: 1 });
    const fitScale = (pdfCanvas.parentElement?.clientWidth ?? 320) / vp1.width;
    const vp = page.getViewport({ scale: fitScale * pdfScale() });
    const w = Math.floor(vp.width);
    const h = Math.floor(vp.height);
    pdfCanvas.width = Math.floor(w * dpr);
    pdfCanvas.height = Math.floor(h * dpr);
    pdfCanvas.style.width = `${w}px`;
    pdfCanvas.style.height = `${h}px`;
    const ctx = pdfCanvas.getContext("2d");
    if (!ctx) return;
    const task = page.render({
      canvas: pdfCanvas,
      canvasContext: ctx,
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    pdfRenderTask = task;
    await task.promise.catch(() => {}); // cancelled by a newer page — fine
    pdfRenderTask = null;
    page.cleanup();
  }

  /** Lazily load pdfjs-dist and open the document from the asset protocol. */
  async function loadPdf(path: string) {
    setPdfError(null);
    try {
      const pdfjs = await import("pdfjs-dist");
      if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        // Vite resolves this to the bundled worker asset (dev + prod).
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();
      }
      const doc = await pdfjs.getDocument({ url: convertFileSrc(path) }).promise;
      setPdfDoc(doc);
      setPdfPage(1);
      setPdfScale(1);
    } catch (e) {
      setPdfError(String(e));
    }
  }

  /** Render a request: resolve per-kind asset URLs (textfile/image/video/pdf are async). */
  async function load(r: PreviewRequest) {
    setReq(r);
    setText(null);
    setImgSrc(null);
    setPoster(null);
    setError(null);
    setFit("contain");
    setFilelist(null);
    // Tear down any previous PDF — the raster pages + parsed doc leave memory
    // only while a PDF is actually shown (close also tears the whole page down).
    const prev = pdfDoc();
    if (prev) {
      prev.loadingTask.destroy().catch(() => {});
      setPdfDoc(null);
    }
    if (r.kind === "textfile" && r.path) {
      try {
        setText(await invoke<string>("get_file_text", { path: r.path }));
      } catch (e) {
        setError(String(e));
      }
    } else if (r.kind === "image") {
      try {
        // Image-file rows carry `path`; image-kind rows resolve via the id.
        const path = r.path ?? (await invoke<string>("get_clipboard_image", { id: r.id }));
        setImgSrc(convertFileSrc(path));
      } catch (e) {
        setError(String(e));
      }
    } else if (r.kind === "video" && r.path) {
      // Shell thumbnail (a frame) as the player's poster — shown until play
      // (the player is preload="none", so without it the area is just black).
      void invoke<string>("get_video_thumb", { path: r.path })
        .then(setPoster)
        .catch(() => setPoster(null));
    } else if (r.kind === "pdf" && r.path) {
      void loadPdf(r.path);
    } else if (r.kind === "filelist" && r.paths) {
      // Multi-file entry: the list, each path's existence, and the checked set
      // (stored override ∩ existing when 记住勾选 on; else every existing file).
      const paths = r.paths.filter(Boolean);
      const exists = await invoke<boolean[]>("check_file_exists", { paths });
      const remember = r.remember_checks ?? true;
      const saved = remember && r.checked ? new Set(r.checked) : null;
      const checked = new Set(
        paths.map((_, i) => i).filter((i) => exists[i] && (!saved || saved.has(i)))
      );
      setFilelist({ paths, exists, checked, remember });
    }
  }

  onMount(async () => {
    // This renderer has its own i18next instance — sync it to the persisted
    // language so the file-list labels match the launcher/settings.
    try {
      const s = await invoke<{ appearance: { language: string } }>("get_settings");
      setLocale(resolveLocale(s.appearance.language));
    } catch {
      // Keep the system-language default.
    }
    // Live updates while the window stays visible (no reload flicker).
    await getCurrentWindow().listen("preview-update", (e) => {
      void load(e.payload as PreviewRequest);
    });
    // Initial payload — also self-corrects a preview-update that raced the page
    // load (the stored request is read after the fact).
    const initial = await invoke<PreviewRequest | null>("get_preview_request");
    if (initial) void load(initial);
  });

  // Re-render the PDF page whenever the doc / page / zoom changes.
  createEffect(() => {
    void pdfDoc();
    void pdfPage();
    void pdfScale();
    void drawPdfPage();
  });

  const mediaSrc = () => (req() && req()!.path ? convertFileSrc(req()!.path!) : "");

  return (
    <div class="preview-body">
        <Show when={req()} fallback={<div class="preview-empty">—</div>}>
          <Show when={!error()} fallback={<div class="preview-error">{error()}</div>}>
            <Switch>
              {/* Text file: content read on demand. */}
              <Match when={req()!.kind === "textfile"}>
                <Show when={text()} fallback={<span class="preview-placeholder">…</span>}>
                  <pre class="preview-text">{text()}</pre>
                </Show>
              </Match>
              {/* Image: contained by default, click toggles natural size. */}
              <Match when={req()!.kind === "image"}>
                <Show when={imgSrc()} fallback={<span class="preview-placeholder">…</span>}>
                  <img
                    class={`preview-img ${fit()}`}
                    src={imgSrc()!}
                    alt=""
                    draggable={false}
                    onClick={() => setFit(fit() === "contain" ? "one-one" : "contain")}
                  />
                </Show>
              </Match>
              {/* preload="none": the file buffers only when the user presses play. */}
              <Match when={req()!.kind === "audio"}>
                <audio src={mediaSrc()} controls preload="none" />
              </Match>
              {/* poster = a shell-extracted frame, shown until play (the player
                  is preload="none" so the file itself only loads on play). */}
              <Match when={req()!.kind === "video"}>
                <video src={mediaSrc()} poster={poster() ?? undefined} controls preload="none" />
              </Match>
              {/* Multi-file list (ROADMAP #17): every recorded file with a
                  checkbox; missing files are struck through + disabled. Copy /
                  paste in the launcher only uses the checked files. */}
              <Match when={req()!.kind === "filelist"}>
                <Show when={filelist()} fallback={<span class="preview-placeholder">…</span>}>
                  <div class="preview-files">
                    <div class="preview-files-head">
                      <span class="preview-files-count">
                        {t("fileCount", { count: String(filelist()!.paths.length) })}
                      </span>
                      <label class="preview-remember">
                        <input
                          type="checkbox"
                          checked={filelist()!.remember}
                          onChange={(e) =>
                            toggleRemember((e.currentTarget as HTMLInputElement).checked)
                          }
                        />
                        <span>{t("rememberChecks")}</span>
                      </label>
                    </div>
                    <ul class="preview-files-list">
                      <For each={filelist()!.paths}>
                        {(p, i) => {
                          const idx = i();
                          const gone = !filelist()!.exists[idx];
                          return (
                            <li classList={{ "preview-file": true, gone }}>
                              <input
                                type="checkbox"
                                checked={filelist()!.checked.has(idx)}
                                disabled={gone}
                                onChange={(e) =>
                                  toggleFile(idx, (e.currentTarget as HTMLInputElement).checked)
                                }
                              />
                              <span class="preview-file-name" title={p}>
                                {basename(p)}
                              </span>
                            </li>
                          );
                        }}
                      </For>
                    </ul>
                  </div>
                </Show>
              </Match>
              {/* PDF (PDF.js): visible page only, page flip + zoom in the toolbar. */}
              <Match when={req()!.kind === "pdf"}>
                <Show when={!pdfError()} fallback={<div class="preview-error">{pdfError()}</div>}>
                  <Show when={pdfDoc()} fallback={<span class="preview-placeholder">…</span>}>
                    <div class="preview-pdf">
                      <div class="preview-pdf-scroll">
                        <canvas
                          class="preview-pdf-canvas"
                          ref={(el) => {
                            pdfCanvas = el;
                            void drawPdfPage();
                          }}
                        />
                      </div>
                      <div class="preview-pdf-toolbar">
                        <button
                          class="preview-pdf-btn"
                          title="上一页"
                          aria-label="上一页"
                          disabled={pdfPage() <= 1}
                          onClick={() => setPdfPage((p) => Math.max(1, p - 1))}
                        >‹</button>
                        <span class="preview-pdf-page">
                          {pdfPage()} / {pdfDoc()?.numPages ?? 1}
                        </span>
                        <button
                          class="preview-pdf-btn"
                          title="下一页"
                          aria-label="下一页"
                          disabled={pdfPage() >= (pdfDoc()?.numPages ?? 1)}
                          onClick={() =>
                            setPdfPage((p) => Math.min(pdfDoc()?.numPages ?? 1, p + 1))
                          }
                        >›</button>
                        <span class="preview-pdf-sep" />
                        <button
                          class="preview-pdf-btn"
                          title="缩小"
                          aria-label="缩小"
                          disabled={pdfScale() <= 0.25}
                          onClick={() => setPdfScale((s) => Math.max(0.25, s / 1.25))}
                        >−</button>
                        <span class="preview-pdf-page">{Math.round(pdfScale() * 100)}%</span>
                        <button
                          class="preview-pdf-btn"
                          title="放大"
                          aria-label="放大"
                          disabled={pdfScale() >= 4}
                          onClick={() => setPdfScale((s) => Math.min(4, s * 1.25))}
                        >＋</button>
                      </div>
                    </div>
                  </Show>
                </Show>
              </Match>
            </Switch>
          </Show>
        </Show>
    </div>
  );
}

render(() => <PreviewApp />, document.getElementById("root") as HTMLElement);
