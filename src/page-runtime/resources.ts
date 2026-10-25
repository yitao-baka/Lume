//! Resource references crossing into a Presenter. The host resolves plugin
//! paths and native icon/thumbnail caches first; only these explicit schemes
//! survive the boundary.

import type { ResourceRef } from "./contracts";
import { pushDiagnostic } from "./diagnostics";

const DATA_IMAGE =
  /^(?:data:image\/(?:png|jpe?g|gif|webp);(?:[^,]*;)?base64|data:image\/svg\+xml;(?:[^,]*;)?(?:base64|utf8)),/i;
const SAFE_URL = /^(?:https?:|asset:|lume-resource:)/i;

export interface ResolvedResource {
  src: string;
  kind: ResourceRef["kind"];
  alt?: string;
  width?: number;
  height?: number;
}

/** Validate one resource reference without touching the DOM. */
export function validateResourceRef(ref: ResourceRef, path = "$"): void {
  if (!ref || typeof ref !== "object") throw new Error(`${path}: resource must be an object`);
  if (!["url", "asset", "file-icon", "thumbnail"].includes(ref.kind)) {
    throw new Error(`${path}: invalid resource kind "${String(ref.kind)}"`);
  }
  if (typeof ref.src !== "string" || ref.src.length === 0) {
    throw new Error(`${path}: resource src is required`);
  }
  assertResourceLength(ref.src, `${path}.src`);
  assertAllowedResourceUrl(ref.src, `${path}.src`);
  if (ref.light !== undefined) {
    assertResourceLength(ref.light, `${path}.light`);
    assertAllowedResourceUrl(ref.light, `${path}.light`);
  }
  if (ref.dark !== undefined) {
    assertResourceLength(ref.dark, `${path}.dark`);
    assertAllowedResourceUrl(ref.dark, `${path}.dark`);
  }
  for (const [key, value] of Object.entries({ width: ref.width, height: ref.height })) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > 8192)) {
      throw new Error(`${path}.${key}: expected 0 < value <= 8192`);
    }
  }
}

function assertAllowedResourceUrl(src: string, path: string): void {
  if (DATA_IMAGE.test(src) || SAFE_URL.test(src)) return;
  pushDiagnostic("__pageResources", { path, error: "scheme refused" });
  throw new Error(`${path}: resource scheme refused`);
}

function assertResourceLength(src: string, path: string): void {
  // Inline image thumbnails legitimately exceed the URL-length cap; the Page
  // Model's total byte limit still bounds them. External URLs stay tightly
  // capped so a malformed manifest/model cannot smuggle arbitrary payloads.
  const limit = DATA_IMAGE.test(src) ? 512 * 1024 : 8192;
  if (src.length > limit) {
    throw new Error(`${path}: resource src exceeds ${limit} chars`);
  }
}

/** Resolve a resource for a presenter surface. Theme selection is explicit:
 * the host chooses the matching variant before handing it to the Presenter. */
export function resolveResource(
  ref: ResourceRef,
  theme: "light" | "dark"
): ResolvedResource {
  validateResourceRef(ref);
  const src =
    theme === "light"
      ? ref.light ?? ref.src ?? ref.dark
      : ref.dark ?? ref.src ?? ref.light;
  if (!src) throw new Error("resource has no usable URL");
  assertAllowedResourceUrl(src, "resource");
  return {
    src,
    kind: ref.kind,
    ...(ref.alt ? { alt: ref.alt } : {}),
    ...(ref.width ? { width: ref.width } : {}),
    ...(ref.height ? { height: ref.height } : {}),
  };
}
