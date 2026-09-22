//! 「插件」页 — a plugin manager, not a flat list. Each plugin renders as a
//! card: icon tile, name + badges, description, and an enable toggle; the
//! card body expands into a detail panel with the declared keywords, entry
//! rules, capability chips (localized + explained), the 全部授权 escape
//! hatch, the plugin's declarative settings (P3.4) and its on-disk location.
//!
//! Toggling writes `settings.plugins.disabled` (light write) and emits
//! `settings-applied`; the launcher re-reads the registry and a disabled
//! active mode falls back to Navigate. 「全部授权」 writes
//! `settings.plugins.trusted` and the same event re-reads the manifests, so
//! the launcher's permission checks see the new state immediately.

import { createSignal, For, onMount, Show } from "solid-js";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { t, type Messages } from "../i18n";
import type { PluginManifest, PluginSetting } from "../plugins/types";
import { Chip, Toggle } from "./controls";
import reloadIcon from "../../res/icons/refresh.svg";

/** Localized label for a plugin kind. */
function kindLabel(kind: string): string {
  if (kind === "mode") return t("pluginKindMode" as keyof Messages);
  if (kind === "service") return t("pluginKindService" as keyof Messages);
  if (kind === "provider") return t("pluginKindProvider" as keyof Messages);
  return kind;
}

/** Capability words (manifest `permissions`, enforced by the P3.2 layer)
 * mapped to localized labels + one-line explanations. Unknown words from a
 * newer manifest degrade to the raw word. */
const PERM_INFO: Record<string, { label: keyof Messages; desc: keyof Messages }> = {
  clipboard: { label: "permClipboard", desc: "permClipboardDesc" },
  network: { label: "permNetwork", desc: "permNetworkDesc" },
  notify: { label: "permNotify", desc: "permNotifyDesc" },
  dialog: { label: "permDialog", desc: "permDialogDesc" },
  screen: { label: "permScreen", desc: "permScreenDesc" },
  "search.files": { label: "permSearchFiles", desc: "permSearchFilesDesc" },
  "fs.read": { label: "permFsRead", desc: "permFsReadDesc" },
  "fs.write": { label: "permFsWrite", desc: "permFsWriteDesc" },
  trash: { label: "permTrash", desc: "permTrashDesc" },
};

function permLabel(perm: string): string {
  const info = PERM_INFO[perm];
  return info ? t(info.label) : perm;
}

function permDesc(perm: string): string {
  const info = PERM_INFO[perm];
  return info ? t(info.desc) : perm;
}

/** Built-ins ship with an empty manifest description — give the two of them
 * a localized one so the cards self-explain like disk plugins do. */
const BUILTIN_DESC: Record<string, keyof Messages> = {
  clipboard: "pluginDescClipboard",
  preview: "pluginDescPreview",
};

function pluginDescription(p: PluginManifest): string {
  if (p.description) return p.description;
  const key = BUILTIN_DESC[p.id];
  return key ? t(key) : "";
}

/** Manifest icon → URL (data:/http pass through; a relative path resolves
 * against the plugin dir via the asset protocol — same rule as the
 * launcher's pill icons). */
function pluginIcon(p: PluginManifest): string | undefined {
  if (typeof p.icon !== "string" || p.icon === "") return undefined;
  if (/^(data:|https?:|asset:|blob:)/i.test(p.icon)) return p.icon;
  if (p.dir && !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(p.icon)) {
    return convertFileSrc(p.dir + "\\" + p.icon);
  }
  return convertFileSrc(p.icon);
}

type Filter = "all" | "enabled" | "disabled" | "disk";

const FILTERS: { id: Filter; label: keyof Messages }[] = [
  { id: "all", label: "pluginsFilterAll" },
  { id: "enabled", label: "pluginsFilterEnabled" },
  { id: "disabled", label: "pluginsFilterDisabled" },
  { id: "disk", label: "pluginsFilterDisk" },
];

export default function PluginsPane() {
  const [plugins, setPlugins] = createSignal<PluginManifest[]>([]);
  const [status, setStatus] = createSignal<{ ok: boolean; text: string } | null>(null);
  /** Which plugin's detail panel is open (one at a time keeps the list
   * scannable) and the declared-setting values loaded for it. */
  const [openId, setOpenId] = createSignal<string | null>(null);
  /** Declared-setting values per plugin id (loaded when its detail opens). */
  const [values, setValues] = createSignal<Record<string, Record<string, unknown>>>({});
  const [filter, setFilter] = createSignal<Filter>("all");
  const [needle, setNeedle] = createSignal("");
  let statusTimer: ReturnType<typeof setTimeout> | undefined;

  async function refresh() {
    try {
      setPlugins(await invoke<PluginManifest[]>("get_plugins"));
    } catch (err) {
      showStatus(false, String(err));
    }
  }

  onMount(refresh);

  function showStatus(ok: boolean, text: string) {
    setStatus({ ok, text });
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => setStatus(null), 2400);
  }

  const enabledCount = () => plugins().filter((p) => p.enabled).length;

  const visible = () => {
    const n = needle().trim().toLowerCase();
    return plugins().filter((p) => {
      if (filter() === "enabled" && !p.enabled) return false;
      if (filter() === "disabled" && p.enabled) return false;
      if (filter() === "disk" && p.builtin) return false;
      if (n) {
        const hay = `${p.name} ${p.id} ${p.description} ${p.keywords.join(" ")}`.toLowerCase();
        if (!hay.includes(n)) return false;
      }
      return true;
    });
  };

  async function toggle(p: PluginManifest, v: boolean) {
    try {
      await invoke("set_plugin_enabled", { id: p.id, enabled: v });
      setPlugins((list) => list.map((x) => (x.id === p.id ? { ...x, enabled: v } : x)));
      showStatus(true, t(v ? "pluginToastEnabled" : "pluginToastDisabled", { name: p.name || p.id }));
    } catch (err) {
      showStatus(false, String(err));
    }
  }

  /** 「全部授权」 — pass every capability check for this plugin, declared or
   * not (the development escape hatch; see PLUGIN_API §6D.6). */
  async function trust(p: PluginManifest, v: boolean) {
    try {
      await invoke("set_plugin_trusted", { id: p.id, trusted: v });
      setPlugins((list) => list.map((x) => (x.id === p.id ? { ...x, trusted: v } : x)));
      showStatus(
        true,
        t(v ? "pluginToastTrustedOn" : "pluginToastTrustedOff", { name: p.name || p.id }),
      );
    } catch (err) {
      showStatus(false, String(err));
    }
  }

  /** Hot-reload one disk plugin: the launcher unloads + re-imports it from
   * disk (its `plugin-reload` event path), so code edits apply without
   * restarting Lume. Built-ins have nothing to reload from disk. */
  async function reload(p: PluginManifest) {
    try {
      await invoke("reload_plugin", { id: p.id });
      showStatus(true, t("pluginToastReloaded", { name: p.name || p.id }));
    } catch (err) {
      showStatus(false, String(err));
    }
  }

  /** Open/close a plugin's detail panel, loading the effective setting
   * values the first time (defaults ⊕ whatever the user changed). */
  async function toggleOpen(p: PluginManifest) {
    if (openId() === p.id) {
      setOpenId(null);
      return;
    }
    setOpenId(p.id);
    if (p.settings.length > 0 && values()[p.id] === undefined) {
      try {
        const v = await invoke<Record<string, unknown>>("plugin_settings_get", { id: p.id });
        setValues((all) => ({ ...all, [p.id]: v ?? {} }));
      } catch (err) {
        showStatus(false, String(err));
      }
    }
  }

  /** Write one setting; the plugin hears about it through the
   * `plugin-settings` event the Rust command emits. */
  async function putSetting(p: PluginManifest, key: string, value: unknown) {
    const before = { ...(values()[p.id] ?? {}) };
    setValues((all) => ({ ...all, [p.id]: { ...before, [key]: value } })); // optimistic
    try {
      await invoke("plugin_settings_put", { id: p.id, key, value });
    } catch (err) {
      setValues((all) => ({ ...all, [p.id]: before }));
      showStatus(false, String(err));
    }
  }

  return (
    <>
      <h2 class="settings-grouptitle">{t("plugins")}</h2>
      {/* Summary + filter toolbar */}
      <div class="plg-toolbar">
        <span class="plg-summary">
          {t("pluginsSummary", {
            total: String(plugins().length),
            enabled: String(enabledCount()),
          })}
        </span>
        <span class="plg-filter-chips">
          <For each={FILTERS}>
            {(f) => (
              <button
                class="plg-filter-chip"
                classList={{ active: filter() === f.id }}
                onClick={() => setFilter(f.id)}
              >
                {t(f.label)}
              </button>
            )}
          </For>
        </span>
        <input
          class="settings-text-input plg-filter-input"
          type="text"
          placeholder={t("pluginsFilterPlaceholder")}
          value={needle()}
          onInput={(e) => setNeedle(e.currentTarget.value)}
        />
      </div>

      <div class="plg-list">
        <For each={visible()} fallback={<div class="plg-empty">{t("pluginsEmpty")}</div>}>
          {(p) => (
            <PluginCard
              p={p}
              open={openId() === p.id}
              settingValues={values()[p.id] ?? ({} as Record<string, unknown>)}
              onToggleOpen={() => void toggleOpen(p)}
              onToggleEnabled={(v) => void toggle(p, v)}
              onTrust={(v) => void trust(p, v)}
              onReload={() => void reload(p)}
              onPutSetting={(key, value) => void putSetting(p, key, value)}
            />
          )}
        </For>
      </div>
      <Show when={status()}>
        <span class="settings-status" classList={{ error: !status()!.ok }}>
          {status()!.text}
        </span>
      </Show>
    </>
  );
}

/** One plugin card: icon tile + name row + description, an enable toggle
 * (and 重载 for disk plugins) on the right, and an expandable detail panel
 * below. The header click toggles the panel; the embedded controls don't. */
function PluginCard(props: {
  p: PluginManifest;
  open: boolean;
  settingValues: Record<string, unknown>;
  onToggleOpen: () => void;
  onToggleEnabled: (v: boolean) => void;
  onTrust: (v: boolean) => void;
  onReload: () => void;
  onPutSetting: (key: string, value: unknown) => void;
}) {
  const p = () => props.p;
  const icon = () => pluginIcon(p());
  const tileChar = () => (p().name || p().id).trim().charAt(0).toUpperCase() || "·";
  const desc = () => pluginDescription(p());

  return (
    <div class="plg-card" classList={{ open: props.open, off: !p().enabled }}>
      <div class="plg-head" onClick={props.onToggleOpen}>
        <div class="plg-tile" classList={{ [p().kind]: true }}>
          <Show when={icon()} fallback={<span class="plg-tile-letter">{tileChar()}</span>}>
            <img src={icon()} alt="" draggable={false} />
          </Show>
        </div>
        <div class="plg-main">
          <div class="plg-name-row">
            <span class="plg-name">{p().name || p().id}</span>
            <span class="plg-ver">{p().version}</span>
            <span class="plg-badge" classList={{ builtin: p().builtin }}>
              {p().builtin ? t("pluginBuiltin") : t("pluginDisk")}
            </span>
            <Show when={p().development}>
              <span class="plg-badge dev">{t("pluginDev")}</span>
            </Show>
          </div>
          <Show when={desc()}>
            <div class="plg-desc">{desc()}</div>
          </Show>
          <div class="plg-sub">
            <span>{kindLabel(p().kind)}</span>
            <Show when={p().keywords.length > 0}>
              <span class="plg-sub-sep">·</span>
              <span class="plg-keywords-preview">{p().keywords.join(" / ")}</span>
            </Show>
          </div>
        </div>
        <div class="plg-actions" onClick={(e) => e.stopPropagation()}>
          <Show when={!p().builtin}>
            <button class="settings-icon-btn" title={t("pluginReload")} onClick={props.onReload}>
              <img class="settings-icon-btn-icon" src={reloadIcon} alt="" draggable={false} />
            </button>
          </Show>
          <Toggle checked={p().enabled} onChange={props.onToggleEnabled} />
          <span class="plg-chev" classList={{ open: props.open }}>▸</span>
        </div>
      </div>

      <Show when={props.open}>
        <div class="plg-detail">
          <Show when={p().keywords.length > 0}>
            <div class="plg-dsec">
              <span class="plg-dlabel">{t("pluginDetailKeywords")}</span>
              <div class="plg-chiprow">
                <For each={p().keywords}>
                  {(k) => <span class="plg-kw-chip">{k}</span>}
                </For>
              </div>
            </div>
          </Show>

          <Show when={p().features.length > 0}>
            <div class="plg-dsec">
              <span class="plg-dlabel">{t("pluginDetailFeatures")}</span>
              <div class="plg-chiprow">
                <For each={p().features}>
                  {(f) => (
                    <span class="plg-feature" title={f.regex || (f.over ? ".*" : "")}>
                      <span class="plg-feature-label">{f.label || f.code}</span>
                      <span class="settings-chip-mini">{featureTypeLabel(f.type)}</span>
                    </span>
                  )}
                </For>
              </div>
            </div>
          </Show>

          {/* Capabilities (P3.2): what the manifest declares, with the
              enforced-by-default note and the 全部授权 escape hatch.
              Built-ins declare nothing — their code ships with Lume. */}
          <Show when={!p().builtin}>
            <div class="plg-dsec">
              <span class="plg-dlabel">{t("pluginPermissions")}</span>
              <Show
                when={p().permissions.length > 0}
                fallback={<span class="plg-note">{t("pluginNoPermissions")}</span>}
              >
                <div class="plg-chiprow">
                  <For each={p().permissions}>
                    {(perm) => (
                      <span class="plg-perm-chip" title={permDesc(perm)}>
                        {permLabel(perm)}
                      </span>
                    )}
                  </For>
                </div>
              </Show>
              <span class="plg-note">{t("pluginPermEnforcedHint")}</span>
              <div class="plg-trust">
                <span class="plg-note warn">{t("pluginTrustHint")}</span>
                <Toggle checked={p().trusted} onChange={props.onTrust} />
              </div>
            </div>
          </Show>

          {/* Declared settings (P3.4) — the manifest describes the inputs,
              the pane renders them and writes through to the store. */}
          <Show when={p().settings.length > 0}>
            <div class="plg-dsec">
              <span class="plg-dlabel">{t("pluginSettings")}</span>
              <For each={p().settings}>
                {(s) => (
                  <SettingRow
                    setting={s}
                    value={props.settingValues[s.key]}
                    onCommit={(v) => props.onPutSetting(s.key, v)}
                  />
                )}
              </For>
            </div>
          </Show>

          <div class="plg-dsec">
            <div class="plg-kv">
              <span class="plg-k">ID</span>
              <span class="plg-v mono">{p().id}</span>
            </div>
            <Show when={p().dir}>
              <div class="plg-kv">
                <span class="plg-k">{t("pluginDetailDir")}</span>
                <span class="plg-v mono" title={p().dir}>{p().dir}</span>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

function featureTypeLabel(type: string): string {
  if (type === "files") return t("pluginFeatureTypeFiles");
  if (type === "img") return t("pluginFeatureTypeImg");
  return t("pluginFeatureTypeText");
}

/** One declared setting: toggle / select (chips) / text. An unknown `type`
 * renders as text, so a manifest from a newer version degrades gracefully.
 * A non-default value shows the factory default underneath for context. */
function SettingRow(props: {
  setting: PluginSetting;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  const isToggle = () => props.setting.type === "toggle";
  const isSelect = () => props.setting.type === "select" && props.setting.options.length > 0;
  const changed = () => props.value !== undefined && props.value !== props.setting.default;
  const defaultText = () => {
    const d = props.setting.default;
    if (d == null || d === "") return null;
    if (isToggle()) return null; // a toggle's default is self-evident
    if (isSelect()) {
      const opt = props.setting.options.find((o) => o.value === d);
      return opt?.label || String(d);
    }
    return String(d);
  };
  return (
    <div class="plg-setting">
      <div class="settings-row-between">
        <span class="settings-sub-label">{props.setting.label}</span>
        <Show when={isToggle()}>
          <Toggle
            checked={props.value === true}
            onChange={(v) => props.onCommit(v)}
          />
        </Show>
        <Show when={isSelect()}>
          <span class="settings-row-chips" style={{ display: "inline-flex" }}>
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
            placeholder={props.setting.default == null ? "" : String(props.setting.default)}
            onChange={(e) => props.onCommit(e.currentTarget.value)}
          />
        </Show>
      </div>
      <Show when={changed() && defaultText() !== null}>
        <span class="plg-default-hint">
          {t("pluginSettingDefault", { value: defaultText() ?? "" })}
        </span>
      </Show>
    </div>
  );
}
