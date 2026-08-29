//! Settings window — Chrome-style top bar (title + 设置搜索框), a 7-section
//! nav (外观 / 导航页 / 剪贴板 / 快捷键 / 搜索 / 系统 / 关于), grouped cards
//! and a footer of 恢复默认设置 + 保存并应用 (docs/SETTINGS.md).
//!
//! The search box filters sections the same way the Flutter settings exe
//! does: each section carries a list of i18n keys whose localized text (plus
//! the section label) is matched case-insensitively; non-matching sections
//! vanish from the nav and the content shows all matches stacked.

import { createEffect, createMemo, createSignal, For, Match, Show, Switch, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { resolveLocale, setLocale, t, type Messages } from "../i18n";
import { applyColorMode } from "../theme";
import AppearancePane from "./AppearancePane";
import LauncherPane from "./LauncherPane";
import ClipboardPane from "./ClipboardPane";
import HotkeysPane from "./HotkeysPane";
import SearchPane from "./SearchPane";
import SystemPane from "./SystemPane";
import AboutPane from "./AboutPane";
import appearanceIcon from "../../res/icons/platte.svg";
import launcherIcon from "../../res/icons/navigate.svg";
import clipboardIcon from "../../res/icons/clipboard.svg";
import hotkeysIcon from "../../res/icons/keyboard.svg";
import searchIcon from "../../res/icons/search.svg";
import systemIcon from "../../res/icons/system.svg";
import aboutIcon from "../../res/icons/about.svg";
import { DEFAULT_SETTINGS, type SettingsData } from "./types";

type Section =
  | "appearance"
  | "launcher"
  | "clipboard"
  | "hotkeys"
  | "search"
  | "system"
  | "about";

const SECTIONS: Section[] = [
  "appearance",
  "launcher",
  "clipboard",
  "hotkeys",
  "search",
  "system",
  "about",
];

const SECTION_ICONS: Record<Section, string> = {
  appearance: appearanceIcon,
  launcher: launcherIcon,
  clipboard: clipboardIcon,
  hotkeys: hotkeysIcon,
  search: searchIcon,
  system: systemIcon,
  about: aboutIcon,
};

const SECTION_LABELS: Record<Section, keyof Messages> = {
  appearance: "navAppearance",
  launcher: "navLauncher",
  clipboard: "clipboard",
  hotkeys: "navHotkeys",
  search: "navSearch",
  system: "system",
  about: "about",
};

/** Localized texts each section is searched by (mirrors the Flutter exe's
 * per-section `_cardText` lists). */
const SECTION_SEARCH_KEYS: Record<Section, (keyof Messages)[]> = {
  appearance: ["settingsLanguage", "settingsColorMode"],
  launcher: [
    "settingsWidth", "settingsHeight", "settingsWindowPosition",
    "showRecent", "showExplorerBar", "expandPinned", "shiftEnterAdmin",
    "recentCount", "placeholderApps", "placeholderClipboard",
    "rememberLastPage", "settingsEntrySize",
  ],
  clipboard: [
    "clipHistoryCap", "clipRecordImages", "clipRecordFiles", "clipMergeCopy",
    "clipIgnoreApps", "clipDedup", "clipShowSource", "clipTimeDisplay",
    "clipHoverSelect", "clipFavoritesTop", "clipPasteClose",
    "settingsClipPreview", "rememberChecks",
  ],
  hotkeys: ["settingsHotkeys", "settingsToggleLauncher", "settingsSwitchMode"],
  search: ["settingsIndexDirs", "settingsSystemIndex", "settingsUserIndex", "settingsCacheRefresh"],
  system: ["settingsAutostart", "settingsSystemService", "settingsImportExport"],
  about: ["aboutTagline", "aboutVersion", "aboutLicense", "aboutAuthor", "aboutHomepage"],
};

export default function Settings() {
  const [section, setSection] = createSignal<Section>("appearance");
  const [query, setQuery] = createSignal("");
  /** True once the user has changed anything (enables 保存并应用). */
  const [dirty, setDirty] = createSignal(false);
  /** Working copy of the settings, loaded at open. */
  const [settings, setSettings] = createSignal<SettingsData | null>(null);
  const [toast, setToast] = createSignal<string | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    void invoke<SettingsData>("get_settings")
      .then(setSettings)
      .catch(() => {});
  });

  /** Apply the selected language + color mode to this window immediately
   * (live preview). */
  createEffect(() => {
    const s = settings();
    if (s) {
      setLocale(resolveLocale(s.appearance.language));
      applyColorMode(s.appearance.color_mode);
    }
  });

  function showToast(text: string) {
    setToast(text);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(null), 2000);
  }

  /** Sections matching the current search query (all of them when empty). */
  const matchingSections = createMemo<Section[]>(() => {
    const needle = query().trim().toLowerCase();
    if (!needle) return SECTIONS;
    return SECTIONS.filter((s) => {
      if (t(SECTION_LABELS[s]).toLowerCase().includes(needle)) return true;
      return SECTION_SEARCH_KEYS[s].some((key) =>
        t(key).toLowerCase().includes(needle)
      );
    });
  });

  /** Update the working copy of appearance and mark the settings dirty. */
  function updateAppearance(patch: Partial<SettingsData["appearance"]>) {
    setSettings((s) =>
      s ? { ...s, appearance: { ...s.appearance, ...patch } } : s
    );
    setDirty(true);
  }

  /** Update the working copy of hotkeys and mark the settings dirty. */
  function updateHotkeys(patch: Partial<SettingsData["hotkeys"]>) {
    setSettings((s) =>
      s ? { ...s, hotkeys: { ...s.hotkeys, ...patch } } : s
    );
    setDirty(true);
  }

  /** Update the working copy of the index and mark the settings dirty. */
  function updateIndex(patch: Partial<SettingsData["index"]>) {
    setSettings((s) => (s ? { ...s, index: { ...s.index, ...patch } } : s));
    setDirty(true);
  }

  /** Update the working copy of the clipboard settings and mark dirty. */
  function updateClipboard(patch: Partial<SettingsData["clipboard"]>) {
    setSettings((s) =>
      s ? { ...s, clipboard: { ...s.clipboard, ...patch } } : s
    );
    setDirty(true);
  }

  /** Re-read the persisted settings (after import / restore backup) and clear dirty. */
  function reloadSettings() {
    void invoke<SettingsData>("get_settings")
      .then((s) => {
        setSettings(s);
        setDirty(false);
      })
      .catch(() => {});
  }

  /** 「恢复默认设置」— reset the working copy only (two-step, like the Flutter
   * settings); nothing is written until 保存并应用. */
  function restoreDefaults() {
    setSettings(structuredClone(DEFAULT_SETTINGS));
    setDirty(true);
    showToast(t("settingsRestoreDefault"));
  }

  /** 「保存并应用」: write + apply the settings, then close the window. */
  async function saveAndClose() {
    const s = settings();
    if (!s) return;
    try {
      await invoke("save_settings", { new: s });
      setDirty(false);
    } catch {
      return; // leave dirty so the user can retry
    }
    try {
      await invoke("close_settings");
    } catch {
      // Window may already be gone — nothing to do.
    }
  }

  return (
    <div class="settings">
      <header class="settings-topbar">
        <span class="settings-appname">Lume</span>
        <div class="settings-search">
          <img class="settings-search-icon" src={searchIcon} alt="" draggable={false} />
          <input
            class="settings-search-input"
            type="text"
            placeholder={t("searchSettings")}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
      </header>
      <div class="settings-content">
        <aside class="settings-sidebar" role="tablist" aria-label={t("settings")}>
          <For each={matchingSections()}>
            {(s) => (
              <button
                class="settings-nav"
                classList={{ active: !query() && section() === s }}
                role="tab"
                aria-selected={!query() && section() === s}
                onClick={() => {
                  setSection(s);
                  setQuery("");
                }}
              >
                <img class="settings-nav-icon" src={SECTION_ICONS[s]} alt="" draggable={false} />
                {t(SECTION_LABELS[s])}
              </button>
            )}
          </For>
        </aside>
        <main class="settings-main">
          <div class="settings-body">
            <Show when={settings()}>
              <Show
                when={!query()}
                fallback={
                  <For each={matchingSections()}>
                    {(s) => (
                      <div class="settings-section" data-section={s}>
                        <SectionBody section={s} settings={settings()!}
                          onUpdateAppearance={updateAppearance}
                          onUpdateHotkeys={updateHotkeys}
                          onUpdateIndex={updateIndex}
                          onUpdateClipboard={updateClipboard}
                          onReload={reloadSettings}
                        />
                      </div>
                    )}
                  </For>
                }
              >
                <SectionBody
                  section={section()}
                  settings={settings()!}
                  onUpdateAppearance={updateAppearance}
                  onUpdateHotkeys={updateHotkeys}
                  onUpdateIndex={updateIndex}
                  onUpdateClipboard={updateClipboard}
                  onReload={reloadSettings}
                />
              </Show>
            </Show>
          </div>
        </main>
      </div>
      <footer class="settings-footer">
        <button class="settings-action" onClick={restoreDefaults}>
          {t("settingsRestoreDefault")}
        </button>
        <button
          class="settings-action settings-action-primary"
          disabled={!dirty()}
          onClick={() => void saveAndClose()}
        >
          {t("saveApply")}
        </button>
      </footer>
      <Show when={toast()}>
        <div class="settings-toast" role="status">{toast()}</div>
      </Show>
    </div>
  );
}

/** The body of one section — `<Switch>/<Match>` so the branch re-runs when
 * `section` changes (a plain `switch` in the function body would freeze on
 * the first mount; the ROADMAP #13.5 SolidJS trap). */
function SectionBody(props: {
  section: Section;
  settings: SettingsData;
  onUpdateAppearance: (patch: Partial<SettingsData["appearance"]>) => void;
  onUpdateHotkeys: (patch: Partial<SettingsData["hotkeys"]>) => void;
  onUpdateIndex: (patch: Partial<SettingsData["index"]>) => void;
  onUpdateClipboard: (patch: Partial<SettingsData["clipboard"]>) => void;
  onReload: () => void;
}) {
  return (
    <Switch>
      <Match when={props.section === "appearance"}>
        <AppearancePane settings={props.settings} onChange={props.onUpdateAppearance} />
      </Match>
      <Match when={props.section === "launcher"}>
        <LauncherPane settings={props.settings} onChange={props.onUpdateAppearance} />
      </Match>
      <Match when={props.section === "clipboard"}>
        <ClipboardPane settings={props.settings} onChange={props.onUpdateClipboard} />
      </Match>
      <Match when={props.section === "hotkeys"}>
        <HotkeysPane settings={props.settings} onChangeHotkeys={props.onUpdateHotkeys} />
      </Match>
      <Match when={props.section === "search"}>
        <SearchPane settings={props.settings} onChangeIndex={props.onUpdateIndex} />
      </Match>
      <Match when={props.section === "system"}>
        <SystemPane settings={props.settings} onReload={props.onReload} />
      </Match>
      <Match when={props.section === "about"}>
        <AboutPane />
      </Match>
    </Switch>
  );
}
