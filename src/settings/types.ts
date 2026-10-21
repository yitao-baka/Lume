//! Shared settings types — mirrors the Rust `Settings` struct
//! (src-tauri/src/settings.rs) for the frontend.

import type { JSX } from "solid-js";

/** A confirm-dialog request — the settings window's shared modal contract:
 * `Settings.tsx` renders the dialog, panes open it through `requestConfirm`.
 * `action` runs on the primary button; a rejection keeps the dialog open and
 * shows the error inline. */
export interface ConfirmState {
  title: string;
  hint: string;
  confirmLabel: string;
  /** Optional structured body rendered between the hint and the actions (the
   * plugin install facts). Pass a thunk: the dialog evaluates it inside its
   * own reactive scope, so the content mounts and disposes with the dialog. */
  details?: () => JSX.Element;
  action: () => Promise<void>;
}

/** Settings-window-only visual language (docs/SETTINGS_SKIN_SWITCH.md). */
export type SettingsSkin = "quiet" | "chromatic";

/** The full settings surface, matching the schema in `docs/SETTINGS.md`. */
export interface SettingsData {
  meta: { version: number };
  appearance: {
    /** `"system"` | `"en"` | `"zh-CN"` | `"zh-TW"`. */
    language: string;
    /** `"system"` | `"dark"` | `"light"` — launcher + settings theme. */
    color_mode: string;
    /** `"quiet"` | `"chromatic"` — settings window only. */
    settings_skin: SettingsSkin;
    /** Settings-window accent: empty follows the skin, otherwise #rrggbb. */
    settings_accent: string;
    /** Entry-box edge length in px — the box wrapping each main-menu entry. */
    entry_size: number;
    /** Crop Navigation result icons to a circle (default off — show the
     * extracted artwork as-is). */
    round_app_icons: boolean;
    /** Launcher horizontal length in px. */
    window_width: number;
    /** Launcher initial vertical length in px (auto-size cap). */
    window_height: number;
    /** `"center"` | `"follow-mouse"` | `"top-left"` | `"top-right"` | `"bottom-left"` | `"bottom-right"`. */
    window_position: string;
    /** Remember the manually-moved window position across shows. */
    remember_position: boolean;
    /** Show the 「最近使用」 bar on the main menu. */
    show_recent: boolean;
    /** Show the 「Windows 资源管理器」 bar (Explorer folder context). */
    show_explorer_bar: boolean;
    /** Start with the 「已固定」 bar expanded. */
    expand_pinned: boolean;
    /** Mode pills show icons only (default off — icon + name). */
    mode_switch_icons_only: boolean;
    /** 各模式独立搜索词 (docs/ROADMAP_HISTORY.md #48) — default off: every mode shares one
     * search-box value (the latest input wins; in-session only, never written
     * to disk). On: each mode remembers its own query like before. */
    per_mode_query: boolean;
    /** Shift+Enter launches the selected app with administrator privileges. */
    shift_enter_admin: boolean;
    /** Cap for the recent-opens list. */
    recent_count: number;
    /** Custom search placeholder for apps mode ("" = localized default). */
    search_placeholder_apps: string;
    /** Custom search placeholder for clipboard mode ("" = localized default). */
    search_placeholder_clipboard: string;
    /** 记住上次所在页面 — restore the last page (mode + clipboard category) on
     * the next summon instead of always starting on Navigate. */
    remember_last_page: boolean;
    /** Last shown mode ("apps" | "clipboard"). */
    last_page: string;
    /** Last clipboard category when last_page === "clipboard". */
    last_page_kind: string;
    /** 闲置重置 (docs/ROADMAP_HISTORY.md #46): after the launcher stayed hidden this long, the
     * next summon starts clean (home, empty query, non-exempt pages reset). */
    idle_reset_enabled: boolean;
    /** Idle-reset threshold in minutes (UI offers 5/15/30/60/120/240). */
    idle_reset_minutes: number;
  };
  hotkeys: { toggle: string; switch_mode: string };
  index: {
    system_dirs: { path: string; enabled: boolean }[];
    /** Named user-index entries (key-value, like Windows env vars). */
    user_index: { name: string; path: string; no_files: boolean }[];
    /** Legacy path list — migration only, always empty after a read. */
    user_dirs: string[];
    /** Legacy no-files list — migration only, always empty after a read. */
    user_dirs_no_files: string[];
    /** Minutes between user-cache refreshes (startup always refreshes once). */
    cache_refresh_interval_minutes: number;
  };
  clipboard: {
    /** Max history rows kept (pinned items exempt from pruning). */
    history_cap: number;
    /** Record image copies into history. */
    record_images: boolean;
    /** Record file/folder copies into history. */
    record_files: boolean;
    /** Hide the launcher after a paste. */
    paste_close: boolean;
    /** Show the source app name in each entry's second line. */
    show_source_app: boolean;
    /** `"relative"` | `"absolute"` — how timestamps are displayed. */
    time_display: string;
    /** App names whose copies are never recorded (foreground process display
     * name, case-insensitive). */
    ignore_apps: string[];
    /** Merge consecutive text copies (within the merge window) into one entry. */
    merge_copy: boolean;
    /** Merge window in milliseconds. */
    merge_window_ms: number;
    /** Mouse hover selects entries (default off — only a click selects). */
    hover_select: boolean;
    /** Sort favorited (pinned) entries to the top of the list. */
    favorites_top: boolean;
    /** Show the satellite preview window (设置/剪贴板 → 开启预览). Off = the
     * preview window never appears; inline row thumbnails stay. */
    preview: boolean;
    /** 内容去重 — identical text/file copies don't add a new row (images keep
     * only the consecutive-repeat guard). */
    dedup: boolean;
    /** 记住勾选 — persist each multi-file entry's checked files across sessions. */
    remember_checks: boolean;
  };
  /** 自动动作 — send a hotkey when a configured program comes to the foreground. */
  automation: {
    /** Master switch for the whole watcher. */
    enabled: boolean;
    /** 延迟到点后前台已移开时的策略: false = skip the send (safe default),
     * true = best-effort pull the target window back to the foreground first. */
    force_focus: boolean;
    /** 使用提权代理 — route the send through the elevated helper, the only way
     * to reach a target running as administrator (`SendInput` is subject to
     * UIPI). On by default; the helper must be registered in 系统 first. */
    use_agent: boolean;
    /** 登录后常驻代理 — keep the helper alive past its idle timeout, instead
     * of letting it exit and re-triggering it on demand. */
    agent_resident: boolean;
    actions: {
      /** Executable to match — full path or bare file name (case-insensitive). */
      process: string;
      /** Hotkey combo to inject, e.g. "Ctrl+Alt+S" (must include a modifier). */
      combo: string;
      /** Per-rule switch. */
      enabled: boolean;
      /** 延迟触发 — ms to wait after the window takes focus before injecting
       * (0 = immediately, max 60000). */
      delay_ms: number;
    }[];
  };
  /** Plugin management (Rust `settings.plugins`). Deliberately partial: this
   * section is mostly Rust-owned (`disabled` / `trusted` / `window_bounds`
   * are consumed by the backend and the settings pane), and only the field
   * the launcher windows read is typed here. It is also optional, so
   * `DEFAULT_SETTINGS` (「恢复应用默认值」) stays free of it. */
  plugins?: {
    /** Per-plugin color-mode preference (`lume.theme.set`docs/ROADMAP_HISTORY.md #36):
     * plugin id → `"system" | "light" | "dark"`. Absent = `"system"`. */
    color_modes?: Record<string, string>;
    /** Idle-reset exemptions (docs/ROADMAP_HISTORY.md #46): plugin id → true keeps its
     * session state across an idle reset, false forces a reset. Absent =
     * the manifest's `keep_session` default. */
    keep_session_overrides?: Record<string, boolean>;
  };
}

/** Mirrors the Rust `impl Default for Settings` (src-tauri/src/settings.rs) —
 * the working copy 「恢复应用默认值」 resets to. */
export const DEFAULT_SETTINGS: SettingsData = {
  meta: { version: 1 },
  appearance: {
    language: "system",
    color_mode: "system",
    settings_skin: "quiet",
    settings_accent: "",
    entry_size: 110,
    round_app_icons: false,
    window_width: 720,
    window_height: 520,
    window_position: "center",
    remember_position: false,
    show_recent: true,
    show_explorer_bar: true,
    expand_pinned: false,
    mode_switch_icons_only: false,
    per_mode_query: false,
    shift_enter_admin: true,
    recent_count: 20,
    search_placeholder_apps: "",
    search_placeholder_clipboard: "",
    remember_last_page: false,
    last_page: "apps",
    last_page_kind: "all",
    idle_reset_enabled: true,
    idle_reset_minutes: 30,
  },
  hotkeys: { toggle: "Alt+Space", switch_mode: "Tab" },
  index: {
    system_dirs: [
      { path: "Desktop", enabled: true },
      { path: "System32", enabled: true },
      { path: "StartMenu", enabled: false },
    ],
    user_index: [],
    user_dirs: [],
    user_dirs_no_files: [],
    cache_refresh_interval_minutes: 60,
  },
  clipboard: {
    history_cap: 200,
    record_images: true,
    record_files: true,
    paste_close: true,
    show_source_app: true,
    time_display: "relative",
    ignore_apps: [],
    merge_copy: false,
    merge_window_ms: 1500,
    hover_select: false,
    favorites_top: false,
    preview: true,
    dedup: true,
    remember_checks: true,
  },
  automation: {
    enabled: true,
    force_focus: false,
    use_agent: true,
    agent_resident: false,
    actions: [],
  },
};

/** A nested partial settings object — only the leaf values that differ. */
export type SettingsPatch = Record<string, unknown>;

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const left = a as unknown[];
    const right = b as unknown[];
    return (
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
    );
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        sameValue(left[key], right[key])
    )
  );
}

/** Compute the minimal patch between the settings loaded into the working
 * copy and the current draft. Untouched sections/fields are omitted, so a
 * save can never overwrite a concurrent light write (plugin enable/disable,
 * last-page bookmark, plugin geometry…). Arrays are replaced wholesale. */
export function diffSettings(
  base: Record<string, unknown>,
  draft: Record<string, unknown>
): SettingsPatch {
  const patch: SettingsPatch = {};
  for (const key of Object.keys(draft)) {
    const next = draft[key];
    const prev = base[key];
    if (sameValue(prev, next)) continue;
    if (
      next !== null &&
      typeof next === "object" &&
      !Array.isArray(next) &&
      prev !== null &&
      typeof prev === "object" &&
      !Array.isArray(prev)
    ) {
      const nested = diffSettings(
        prev as Record<string, unknown>,
        next as Record<string, unknown>
      );
      if (Object.keys(nested).length > 0) patch[key] = nested;
    } else {
      patch[key] = next;
    }
  }
  return patch;
}
