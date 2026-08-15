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
 */
import { render } from "solid-js/web";
import { createSignal, onMount, Show, Switch, Match } from "solid-js";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./preview.css";

/** Mirrors the Rust `PreviewRequest` (window.rs). */
interface PreviewRequest {
  kind: "text" | "textfile" | "image" | "audio" | "video";
  content: string | null;
  path: string | null;
  id: number | null;
}

function PreviewApp() {
  const [req, setReq] = createSignal<PreviewRequest | null>(null);
  const [text, setText] = createSignal<string | null>(null);
  const [imgSrc, setImgSrc] = createSignal<string | null>(null);
  const [poster, setPoster] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  /** "contain" fits the image; clicking toggles to "one-one" (natural size). */
  const [fit, setFit] = createSignal<"contain" | "one-one">("contain");

  /** Render a request: resolve per-kind asset URLs (textfile/image/video are async). */
  async function load(r: PreviewRequest) {
    setReq(r);
    setText(null);
    setImgSrc(null);
    setPoster(null);
    setError(null);
    setFit("contain");
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
    }
  }

  onMount(async () => {
    // Live updates while the window stays visible (no reload flicker).
    await getCurrentWindow().listen("preview-update", (e) => {
      void load(e.payload as PreviewRequest);
    });
    // Initial payload — also self-corrects a preview-update that raced the page
    // load (the stored request is read after the fact).
    const initial = await invoke<PreviewRequest | null>("get_preview_request");
    if (initial) void load(initial);
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
            </Switch>
          </Show>
        </Show>
    </div>
  );
}

render(() => <PreviewApp />, document.getElementById("root") as HTMLElement);
