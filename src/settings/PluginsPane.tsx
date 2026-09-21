//! 「插件」页 — every built-in + discovered plugin with an enable toggle
//! (ROADMAP #7). Toggling writes `settings.plugins.disabled` (light write)
//! and emits `settings-applied`; the launcher re-reads the registry and a
//! disabled active mode falls back to Navigate.

import { createSignal, For, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t, type Messages } from "../i18n";
import type { PluginManifest } from "../plugins/types";
import { Toggle } from "./controls";

/** Localized label for a plugin kind. */
function kindLabel(kind: string): string {
  if (kind === "mode") return t("pluginKindMode" as keyof Messages);
  if (kind === "service") return t("pluginKindService" as keyof Messages);
  if (kind === "provider") return t("pluginKindProvider" as keyof Messages);
  return kind;
}

export default function PluginsPane() {
  const [plugins, setPlugins] = createSignal<PluginManifest[]>([]);
  const [status, setStatus] = createSignal<{ ok: boolean; text: string } | null>(null);

  async function refresh() {
    try {
      setPlugins(await invoke<PluginManifest[]>("get_plugins"));
    } catch (err) {
      setStatus({ ok: false, text: String(err) });
    }
  }

  onMount(refresh);

  async function toggle(p: PluginManifest, v: boolean) {
    try {
      await invoke("set_plugin_enabled", { id: p.id, enabled: v });
      setPlugins((list) => list.map((x) => (x.id === p.id ? { ...x, enabled: v } : x)));
      setStatus({ ok: true, text: p.id + (v ? " ✓" : " ✕") });
    } catch (err) {
      setStatus({ ok: false, text: String(err) });
    }
  }

  /** Hot-reload one disk plugin: the launcher unloads + re-imports it from
   * disk (its `plugin-reload` event path), so code edits apply without
   * restarting Lume. Built-ins have nothing to reload from disk. */
  async function reload(p: PluginManifest) {
    try {
      await invoke("reload_plugin", { id: p.id });
      setStatus({ ok: true, text: p.id + " ↻" });
    } catch (err) {
      setStatus({ ok: false, text: String(err) });
    }
  }

  return (
    <>
      <h2 class="settings-grouptitle">{t("plugins")}</h2>
      <div class="settings-group">
        <For each={plugins()}>
          {(p) => (
            <div class="settings-row-between">
              <div class="settings-plugin-meta">
                <span class="settings-sub-label">
                  {p.name || p.id}
                  <span class="settings-plugin-chips">
                    <span class="settings-chip-mini">{kindLabel(p.kind)}</span>
                    <span class="settings-chip-mini">
                      {p.builtin ? t("pluginBuiltin") : t("pluginDisk")}
                    </span>
                    <Show when={p.development}>
                      <span class="settings-chip-mini">{t("pluginDev")}</span>
                    </Show>
                    <Show when={p.version}>
                      <span class="settings-chip-mini">{p.version}</span>
                    </Show>
                  </span>
                </span>
              </div>
              <div class="settings-plugin-actions">
                <Show when={!p.builtin}>
                  <button class="settings-mini-btn" onClick={() => void reload(p)}>
                    ↻ {t("pluginReload")}
                  </button>
                </Show>
                <Toggle checked={p.enabled} onChange={(v) => void toggle(p, v)} />
              </div>
            </div>
          )}
        </For>
        <span class="settings-hint">
          {t("plugins")} · {plugins().length}
        </span>
      </div>
      <Show when={status()}>
        <span classList={{ "settings-status": true, error: !status()!.ok }}>
          {status()!.text}
        </span>
      </Show>
    </>
  );
}
