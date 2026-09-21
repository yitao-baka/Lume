//! 「插件」页 — every built-in + discovered plugin with an enable toggle
//! (ROADMAP #7), its declared capabilities (P3.2) and its self-described
//! settings (P3.4).
//!
//! Toggling writes `settings.plugins.disabled` (light write) and emits
//! `settings-applied`; the launcher re-reads the registry and a disabled
//! active mode falls back to Navigate. 「全部授权」 writes
//! `settings.plugins.trusted` and the same event re-reads the manifests, so
//! the launcher's permission checks see the new state immediately.

import { createSignal, For, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t, type Messages } from "../i18n";
import type { PluginManifest, PluginSetting } from "../plugins/types";
import { Chip, Toggle } from "./controls";

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
  /** Which plugin's settings block is open (one at a time keeps the list
   * scannable) and the values loaded for it. */
  const [openSettings, setOpenSettings] = createSignal<string | null>(null);
  const [values, setValues] = createSignal<Record<string, unknown>>({});

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

  /** 「全部授权」 — pass every capability check for this plugin, declared or
   * not (the development escape hatch; see PLUGIN_API §6D.6). */
  async function trust(p: PluginManifest, v: boolean) {
    try {
      await invoke("set_plugin_trusted", { id: p.id, trusted: v });
      setPlugins((list) => list.map((x) => (x.id === p.id ? { ...x, trusted: v } : x)));
      setStatus({ ok: true, text: p.id + (v ? " 🔓" : " 🔒") });
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

  /** Open/close a plugin's settings block, loading the effective values the
   * first time (defaults ⊕ whatever the user changed). */
  async function toggleSettings(p: PluginManifest) {
    if (openSettings() === p.id) {
      setOpenSettings(null);
      return;
    }
    try {
      const v = await invoke<Record<string, unknown>>("plugin_settings_get", { id: p.id });
      setValues(v ?? {});
      setOpenSettings(p.id);
    } catch (err) {
      setStatus({ ok: false, text: String(err) });
    }
  }

  /** Write one setting; the plugin hears about it through the
   * `plugin-settings` event the Rust command emits. */
  async function putSetting(p: PluginManifest, key: string, value: unknown) {
    const before = values()[key];
    setValues((v) => ({ ...v, [key]: value })); // optimistic — the write is a plain file write
    try {
      await invoke("plugin_settings_put", { id: p.id, key, value });
      setStatus({ ok: true, text: `${p.id} · ${key}` });
    } catch (err) {
      setValues((v) => ({ ...v, [key]: before }));
      setStatus({ ok: false, text: String(err) });
    }
  }

  return (
    <>
      <h2 class="settings-grouptitle">{t("plugins")}</h2>
      <div class="settings-group">
        <For each={plugins()}>
          {(p) => (
            <>
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
                  {/* Capabilities (P3.2): what the manifest declares, plus the
                      全部授权 escape hatch. Built-ins declare nothing — their
                      code ships with Lume. */}
                  <Show when={!p.builtin}>
                    <span class="settings-plugin-perms">
                      <span class="settings-sub-label">
                        {t("pluginPermissions")}:
                      </span>
                      <Show
                        when={p.permissions.length > 0}
                        fallback={
                          <span class="settings-chip-mini">{t("pluginNoPermissions")}</span>
                        }
                      >
                        <For each={p.permissions}>
                          {(perm) => <span class="settings-chip-mini">{perm}</span>}
                        </For>
                      </Show>
                      <label class="settings-trust-all">
                        <Toggle
                          checked={p.trusted}
                          onChange={(v) => void trust(p, v)}
                        />
                        <span class="settings-sub-label">{t("pluginTrustAll")}</span>
                      </label>
                    </span>
                  </Show>
                </div>
                <div class="settings-plugin-actions">
                  <Show when={p.settings.length > 0}>
                    <button class="settings-mini-btn" onClick={() => void toggleSettings(p)}>
                      {t("pluginSettings")} {openSettings() === p.id ? "▾" : "▸"}
                    </button>
                  </Show>
                  <Show when={!p.builtin}>
                    <button class="settings-mini-btn" onClick={() => void reload(p)}>
                      ↻ {t("pluginReload")}
                    </button>
                  </Show>
                  <Toggle checked={p.enabled} onChange={(v) => void toggle(p, v)} />
                </div>
              </div>
              {/* Declared settings (P3.4) — the manifest describes the inputs,
                  the pane renders them and writes through to the store. */}
              <Show when={openSettings() === p.id}>
                <div class="settings-plugin-settings">
                  <For each={p.settings}>
                    {(s) => (
                      <SettingRow
                        setting={s}
                        value={values()[s.key]}
                        onCommit={(v) => void putSetting(p, s.key, v)}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </>
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

/** One declared setting: toggle / select (chips) / text. An unknown `type`
 * renders as text, so a manifest from a newer version degrades gracefully. */
function SettingRow(props: {
  setting: PluginSetting;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  const isToggle = () => props.setting.type === "toggle";
  const isSelect = () => props.setting.type === "select" && props.setting.options.length > 0;
  return (
    <div class="settings-row-between">
      <span class="settings-sub-label">
        {props.setting.label}
        <span class="settings-chip-mini">{props.setting.key}</span>
      </span>
      <Show when={isToggle()}>
        <Toggle
          checked={props.value === true}
          onChange={(v) => props.onCommit(v)}
        />
      </Show>
      <Show when={isSelect()}>
        <span class="settings-row-chips">
          <For each={props.setting.options}>
            {(o) => (
              <Chip
                label={o.label || o.value}
                active={props.value === o.value}
                onClick={() => props.onCommit(o.value)}
              />
            )}
          </For>
        </span>
      </Show>
      <Show when={!isToggle() && !isSelect()}>
        <input
          class="settings-text-input settings-input-fixed"
          value={props.value == null ? "" : String(props.value)}
          onChange={(e) => props.onCommit(e.currentTarget.value)}
        />
      </Show>
    </div>
  );
}
