//! Shared settings types — mirrors the Rust `Settings` struct
//! (src-tauri/src/settings.rs) for the frontend.

/** The full settings surface, matching the schema in `docs/SETTINGS.md`. */
export interface SettingsData {
  meta: { version: number };
  appearance: {
    /** `"system"` | `"en"` | `"zh-CN"` | `"zh-TW"`. */
    language: string;
    /** `"system"` | `"dark"` | `"light"` — launcher + settings theme. */
    color_mode: string;
    /** Entry-box edge length in px — the box wrapping each main-menu entry. */
    entry_size: number;
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
    /** Start with the 「已固定」 bar expanded. */
    expand_pinned: boolean;
    /** Shift+Enter launches the selected app with administrator privileges. */
    shift_enter_admin: boolean;
    /** Cap for the recent-opens list. */
    recent_count: number;
    /** Custom search placeholder for apps mode ("" = localized default). */
    search_placeholder_apps: string;
    /** Custom search placeholder for clipboard mode ("" = localized default). */
    search_placeholder_clipboard: string;
  };
  hotkeys: { toggle: string; switch_mode: string };
  index: {
    system_dirs: { path: string; enabled: boolean }[];
    user_dirs: string[];
    /** Minutes between user-cache refreshes (startup always refreshes once). */
    cache_refresh_interval_minutes: number;
  };
}
