//! Settings window — a sidebar of sections (界面 / 系统 / 插件 / 关于) with a
//! content pane and 保存 / 应用 actions (docs/SETTINGS.md).
//!
//! The 「界面」pane is live; the others fill in with the following sub-steps
//! (6.5 系统页, 6.6 关于页).

import { createEffect, createSignal, For, Show, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { resolveLocale, setLocale, t, type Messages } from "../i18n";
import { applyColorMode } from "../theme";
import InterfacePane from "./InterfacePane";
import SystemPane from "./SystemPane";
import AboutPane from "./AboutPane";
import interfaceIcon from "../../res/icons/interface.svg";
import systemIcon from "../../res/icons/system.svg";
import pluginsIcon from "../../res/icons/plugins.svg";
import aboutIcon from "../../res/icons/about.svg";
import type { SettingsData } from "./types";

type Section = "interface" | "system" | "plugins" | "about";

const SECTIONS: Section[] = ["interface", "system", "plugins", "about"];

const SECTION_ICONS: Record<Section, string> = {
  interface: interfaceIcon,
  system: systemIcon,
  plugins: pluginsIcon,
  about: aboutIcon,
};

export default function Settings() {
  const [section, setSection] = createSignal<Section>("interface");
  /** True once the user has changed anything (enables 保存 / 应用). */
  const [dirty, setDirty] = createSignal(false);
  /** Working copy of the settings, loaded at open. */
  const [settings, setSettings] = createSignal<SettingsData | null>(null);

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

  /** Re-read the persisted settings (after import / restore) and clear dirty. */
  function reloadSettings() {
    void invoke<SettingsData>("get_settings")
      .then((s) => {
        setSettings(s);
        setDirty(false);
      })
      .catch(() => {});
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
      <aside class="settings-sidebar" role="tablist" aria-label={t("settings")}>
        <For each={SECTIONS}>
          {(s) => (
            <button
              class="settings-nav"
              classList={{ active: section() === s }}
              role="tab"
              aria-selected={section() === s}
              onClick={() => setSection(s)}
            >
              <img class="settings-nav-icon" src={SECTION_ICONS[s]} alt="" draggable={false} />
              {t(s as keyof Messages)}
            </button>
          )}
        </For>
      </aside>
      <main class="settings-main">
        <div class="settings-body">
          <Show when={section() === "interface" && settings()}>
            <InterfacePane settings={settings()!} onChange={updateAppearance} />
          </Show>
          <Show when={section() === "system" && settings()}>
            <SystemPane
              settings={settings()!}
              onChangeHotkeys={updateHotkeys}
              onChangeIndex={updateIndex}
              onReload={reloadSettings}
            />
          </Show>
          <Show when={section() === "plugins"}>
            <div class="settings-placeholder">{t("settingsComingSoon")}</div>
          </Show>
          <Show when={section() === "about"}>
            <AboutPane />
          </Show>
        </div>
        <footer class="settings-footer">
          <button
            class="settings-action settings-action-primary"
            disabled={!dirty()}
            onClick={() => void saveAndClose()}
          >
            {t("saveApply")}
          </button>
        </footer>
      </main>
    </div>
  );
}
