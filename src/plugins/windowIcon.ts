//! Taskbar icon for a detached plugin window (P6.8, ROADMAP #34).
//!
//! The manifest `icon` is usually an SVG and the Rust side has no SVG
//! decoder (`image` is PNG-only), so the webview rasterizes it once at
//! detach time and `plugin_window_open` carries the base64 PNG over; Rust
//! turns it into an HICON. Theme inversion (the `--icon-filter` convention)
//! is applied Rust-side, so a theme flip can rebuild the icon without
//! another round trip.

/** Render size — matches appicon's `ICON_PX`. */
const ICON_PX = 256;

/** Per-URL cache: the raise path calls this on every activation of a
 * detached mode, and the pixels only change when the plugin is reloaded. */
const cache = new Map<string, string | undefined>();

/** Rasterize one plugin icon (an asset URL from `resolvePluginIcon`) into a
 * base64 PNG. `undefined` when it cannot be rasterized (no icon, missing or
 * broken file) — the detached window then keeps the Lume theme icon. */
export function rasterizePluginIcon(url: string): Promise<string | undefined> {
  if (cache.has(url)) return Promise.resolve(cache.get(url));
  return rasterize(url).then((png) => {
    cache.set(url, png);
    return png;
  });
}

async function rasterize(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    // SVG goes through a text → data: URL hop (guaranteed MIME type, and
    // data: images never taint the canvas); anything else (PNG…) uses the
    // fetched blob directly. Both are same-origin to the canvas.
    const src = /\.svg$/i.test(url)
      ? "data:image/svg+xml;charset=utf-8," + encodeURIComponent(await res.text())
      : URL.createObjectURL(await res.blob());
    try {
      const img = new Image();
      img.src = src;
      await img.decode();
      // naturalWidth is 0 for a viewBox-only SVG (Chromium's 300×150-ish
      // default) — the ICON_PX fallback keeps it square-ish instead of
      // dividing by zero.
      const w = img.naturalWidth || ICON_PX;
      const h = img.naturalHeight || ICON_PX;
      const scale = ICON_PX / Math.max(w, h);
      const dw = Math.round(w * scale);
      const dh = Math.round(h * scale);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = ICON_PX;
      const ctx = canvas.getContext("2d");
      if (!ctx) return undefined;
      ctx.drawImage(img, (ICON_PX - dw) / 2, (ICON_PX - dh) / 2, dw, dh);
      const dataUrl = canvas.toDataURL("image/png");
      const comma = dataUrl.indexOf(",");
      return comma >= 0 ? dataUrl.slice(comma + 1) : undefined;
    } finally {
      if (src.startsWith("blob:")) URL.revokeObjectURL(src);
    }
  } catch {
    return undefined;
  }
}
