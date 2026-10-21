//! 「插件」页 — a plugin manager, not a flat list. Each plugin renders as a
//! card: icon tile, name + badges, description, and an enable toggle; the
//! card body expands into a detail panel with the declared keywords, entry
//! rules, capability chips (localized + explained), the 全部授权 escape
//! hatch, the plugin's declarative settings and its on-disk location.
//!
//! Toggling writes `settings.plugins.disabled` (light write) and emits
//! `settings-applied`; the launcher re-reads the registry and a disabled
//! active mode falls back to Navigate. 「全部授权」 writes
//! `settings.plugins.trusted` and the same event re-reads the manifests, so
//! the launcher's permission checks see the new state immediately.

import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { t, type Messages } from "../i18n";
import { pickIcon, resolveThemedIcon } from "../launcher/iconSpec";
import type { PickedIcon } from "../launcher/types";
import type { PluginManifest, PluginSetting } from "../plugins/types";
import { Chip, Toggle } from "./controls";
import { settingsError } from "./errors";
import type { ConfirmState } from "./types";
import reloadIcon from "../../res/icons/refresh.svg";
import deleteIcon from "../../res/icons/delete.svg";

/** What `plugin_lupx_inspect` reports about a picked `.lupx` archive — the
 * install confirmation dialog shows exactly this before anything is written. */
interface LupxInfo {
  id: string;
  name: string;
  version: string;
  kind: string;
  description: string;
  permissions: string[];
  fileCount: number;
  totalBytes: number;
  existingVersion: string | null;
  /** Package version vs the installed one with the same id (`"fresh"` =
   * nothing installed): the card words the overwrite notice by it — the
   * downgrade is the one that warns. Any of the three still installs on
   * confirm. */
  relation: "fresh" | "upgrade" | "reinstall" | "downgrade";
  /** `LUME.SIGN` status (#32.2): `"valid"` = ed25519 signature verified
   * against a trusted key; `"unsigned"` = no signature block (the card shows
   * the archive hash instead). Invalid signatures never reach the card —
   * inspect fails outright. */
  signature: "valid" | "unsigned";
  /** SHA-256 of the whole archive file (integrity display). */
  sha256: string;
}

/** Localized label for a plugin kind. */
function kindLabel(kind: string): string {
  if (kind === "mode") return t("pluginKindMode" as keyof Messages);
  if (kind === "service") return t("pluginKindService" as keyof Messages);
  if (kind === "provider") return t("pluginKindProvider" as keyof Messages);
  return kind;
}

/** Capability words (manifest `permissions`, enforced by the layer)
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
  window: { label: "permWindow", desc: "permWindowDesc" },
};

function permLabel(perm: string): string {
  const info = PERM_INFO[perm];
  return info ? t(info.label) : perm;
}

function permDesc(perm: string): string {
  const info = PERM_INFO[perm];
  return info ? t(info.desc) : perm;
}

/** Bytes → a short human string for the install card ("1.2 MB"). */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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

/** Manifest icon set → a theme pick (docs/ROADMAP_HISTORY.md #44): explicit `icon_light` /
 * `icon_dark` variants win over the legacy `icon`; relative paths resolve
 * against the plugin dir (same rule as the launcher's pill icons). The
 * settings window's own effective theme decides. */
function pluginIcon(p: PluginManifest): PickedIcon | undefined {
  return pickIcon(resolveThemedIcon(p.icon, p.iconLight, p.iconDark, p.dir));
}

type Filter = "all" | "enabled" | "disabled" | "disk";

const FILTERS: { id: Filter; label: keyof Messages }[] = [
  { id: "all", label: "pluginsFilterAll" },
  { id: "enabled", label: "pluginsFilterEnabled" },
  { id: "disabled", label: "pluginsFilterDisabled" },
  { id: "disk", label: "pluginsFilterDisk" },
];

function pluginSearchText(p: PluginManifest): string {
  const settings = p.settings.flatMap((s) => [
    s.label,
    s.key,
    ...s.options.flatMap((o) => [o.label, o.value]),
  ]);
  return `${p.name} ${p.id} ${p.description} ${p.keywords.join(" ")} ${settings.join(" ")}`
    .toLowerCase();
}

export default function PluginsPane(props: {
  searchQuery?: string;
  requestConfirm: (state: ConfirmState, trigger?: HTMLElement) => void;
}) {
  const [plugins, setPlugins] = createSignal<PluginManifest[]>([]);
  const [status, setStatus] = createSignal<{ ok: boolean; text: string } | null>(null);
  /** Global plugin developer mode (settings `plugins.dev_mode`). While off,
   * the developer options — 重载, the global 全部授权 switch, the 开发
   * badge — are hidden and the backend reports every plugin as untrusted. */
  const [devMode, setDevMode] = createSignal(false);
  /** Global 全部授权 (settings `plugins.trust_all`): trust every disk
   * plugin regardless of its manifest. Only effective while dev mode is on
   * (the backend gate); this pane is its only UI. */
  const [trustAll, setTrustAll] = createSignal(false);
  /** Idle-reset exemption overrides (docs/ROADMAP_HISTORY.md #46): plugin id → explicit user
   * value; absent means follow the manifest's `keep_session` default. */
  const [keepOverrides, setKeepOverrides] = createSignal<Record<string, boolean>>({});
  /** Which plugin's detail panel is open (one at a time keeps the list
   * scannable) and the declared-setting values loaded for it. */
  const [openId, setOpenId] = createSignal<string | null>(null);
  /** Declared-setting values per plugin id (loaded when its detail opens). */
  const [values, setValues] = createSignal<Record<string, Record<string, unknown>>>({});
  const [filter, setFilter] = createSignal<Filter>("all");
  const [needle, setNeedle] = createSignal("");
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(statusTimer));

  async function refresh() {
    try {
      setPlugins(await invoke<PluginManifest[]>("get_plugins"));
    } catch (err) {
      showStatus(false, settingsError(err, "pluginsActionFailed"));
    }
  }

  onMount(() => {
    void refresh();
    // Developer mode lives in the settings file — read the initial value
    // (the pane's own controls light-write, so no dirty-state round trip).
    void invoke<unknown>("get_settings")
      .then((s) => {
        const pluginsSlice = (
          s as {
            plugins?: {
              dev_mode?: boolean;
              trust_all?: boolean;
              keep_session_overrides?: Record<string, boolean>;
            };
          }
        ).plugins;
        setDevMode(pluginsSlice?.dev_mode === true);
        setTrustAll(pluginsSlice?.trust_all === true);
        setKeepOverrides({ ...(pluginsSlice?.keep_session_overrides ?? {}) });
      })
      .catch((err) => showStatus(false, settingsError(err, "settingsLoadFailed")));
  });

  function showStatus(ok: boolean, text: string) {
    setStatus({ ok, text });
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => setStatus(null), 2400);
  }

  const enabledCount = () => plugins().filter((p) => p.enabled).length;
  const selectedPlugin = () => plugins().find((plugin) => plugin.id === openId());

  const visible = () => {
    const n = needle().trim().toLowerCase();
    return plugins().filter((p) => {
      if (filter() === "enabled" && !p.enabled) return false;
      if (filter() === "disabled" && p.enabled) return false;
      if (filter() === "disk" && p.builtin) return false;
      if (n) {
        const hay = pluginSearchText(p);
        if (!hay.includes(n)) return false;
      }
      return true;
    });
  };

  // The global settings search passes only plugin-specific queries here. Mirror
  // that text into the local filter, open the first matching card, and let the
  // matching setting row carry the visible highlight.
  createEffect(() => {
    const q = (props.searchQuery ?? "").trim();
    setNeedle(q);
    if (!q) return;
    const needle = q.toLowerCase();
    const first = plugins().find((p) => pluginSearchText(p).includes(needle));
    if (first && openId() !== first.id) void toggleOpen(first);
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(".plg-setting.search-hit, .plg-card.open")
        ?.scrollIntoView({ block: "nearest" });
    });
  });

  async function toggle(p: PluginManifest, v: boolean) {
    try {
      await invoke("set_plugin_enabled", { id: p.id, enabled: v });
      setPlugins((list) => list.map((x) => (x.id === p.id ? { ...x, enabled: v } : x)));
      showStatus(true, t(v ? "pluginToastEnabled" : "pluginToastDisabled", { name: p.name || p.id }));
    } catch (err) {
      showStatus(false, settingsError(err, "pluginsActionFailed"));
    }
  }

  /** Idle-reset exemption (docs/ROADMAP_HISTORY.md #46): writes the user override map; the
   * manifest `keep_session` stays the default when no override exists. */
  async function toggleKeepSession(p: PluginManifest, keep: boolean) {
    try {
      await invoke("set_plugin_keep_session", { id: p.id, keep });
      setKeepOverrides((m) => ({ ...m, [p.id]: keep }));
      showStatus(true, t("pluginToastSettingsSaved"));
    } catch (err) {
      showStatus(false, settingsError(err, "pluginsActionFailed"));
    }
  }

  async function clearKeepSession(p: PluginManifest) {
    try {
      await invoke("clear_plugin_keep_session", { id: p.id });
      setKeepOverrides((m) => {
        const next = { ...m };
        delete next[p.id];
        return next;
      });
      showStatus(true, t("pluginToastSettingsSaved"));
    } catch (err) {
      showStatus(false, settingsError(err, "pluginsActionFailed"));
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
      showStatus(false, settingsError(err, "pluginsActionFailed"));
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
        showStatus(false, settingsError(err, "pluginsActionFailed"));
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
      showStatus(false, settingsError(err, "pluginsActionFailed"));
    }
  }

  /** Global developer mode — light write like the enable toggles; the
   * backend gates the trusted flags so the escape hatches are inert while
   * off. */
  async function toggleDevMode(v: boolean) {
    const before = devMode();
    const beforeTrust = trustAll();
    setDevMode(v); // the visible change is instant; the write is a plain file write
    setTrustAll(false); // backend clears this on every dev-mode transition
    try {
      await invoke("set_plugin_dev_mode", { enabled: v });
      await refresh(); // re-read: trusted flags flip with the gate
      showStatus(true, t(v ? "pluginsDevModeOn" : "pluginsDevModeOff"));
    } catch (err) {
      setDevMode(before);
      setTrustAll(beforeTrust);
      showStatus(false, settingsError(err, "pluginsActionFailed"));
    }
  }

  /** Global 全部授权 — light write like the other plugin controls; the
   * backend reports every disk plugin trusted while this and dev mode are
   * both on. */
  async function performTrustAll(v: boolean) {
    const before = trustAll();
    setTrustAll(v); // optimistic — the write is a plain file write
    try {
      await invoke("set_plugin_trust_all", { enabled: v });
      await refresh(); // re-read: the per-plugin trusted flags flip with the gate
      showStatus(true, t(v ? "pluginsTrustAllOn" : "pluginsTrustAllOff"));
    } catch (err) {
      setTrustAll(before);
      showStatus(false, settingsError(err, "pluginsActionFailed"));
    }
  }

  function toggleTrustAll(v: boolean) {
    if (v) {
      props.requestConfirm({
        title: t("pluginsConfirmTrustAllTitle"),
        hint: t("pluginsConfirmTrustAllHint"),
        confirmLabel: t("pluginTrustAll"),
        action: () => performTrustAll(true),
      });
    } else {
      void performTrustAll(false);
    }
  }

  /** `.lupx` install, step 1 — pick a file and validate it. The Rust side
   * only reads: the confirmation dialog shows the manifest (permissions
   * included) and nothing is written until 确认安装. */
  async function pickLupx(trigger?: HTMLElement) {
    try {
      const picked = await openFileDialog({
        multiple: false,
        filters: [{ name: "Lume Plugin", extensions: ["lupx"] }],
      });
      if (typeof picked !== "string") return; // cancelled
      const info = await invoke<LupxInfo>("plugin_lupx_inspect", { sourcePath: picked });
      props.requestConfirm(
        {
          title: t("pluginsInstallTitle"),
          hint: t("pluginsInstallHint"),
          confirmLabel: t("pluginsInstallConfirm"),
          // A thunk: the dialog evaluates it inside its own reactive scope, so
          // the facts (and their effects) mount and dispose with the dialog.
          details: () => <InstallFacts info={info} />,
          action: () => installLupx(picked, info),
        },
        trigger,
      );
    } catch (err) {
      showStatus(false, settingsError(err, "pluginsActionFailed"));
    }
  }

  /** `.lupx` install, step 2 — the confirm dialog's primary action, after the
   * user saw the facts. The Rust command extracts + swaps and emits
   * `settings-applied` / `plugin-reload`, so the launcher picks the plugin up
   * immediately; a rejection keeps the dialog open with the error inline. */
  async function installLupx(source: string, info: LupxInfo) {
    await invoke("plugin_lupx_install", { sourcePath: source });
    await refresh();
    showStatus(true, t("pluginsInstallDone", { name: info.name || info.id }));
  }

  /** Uninstall one disk plugin: the directory (its private `files/` with it)
   * is deleted; the document store keeps the plugin's data. */
  async function uninstall(p: PluginManifest) {
    try {
      await invoke("plugin_uninstall", { id: p.id });
      await refresh();
      showStatus(true, t("pluginUninstalled", { name: p.name || p.id }));
    } catch (err) {
      showStatus(false, settingsError(err, "pluginsActionFailed"));
    }
  }

  function askUninstall(p: PluginManifest) {
    props.requestConfirm({
      title: t("pluginsConfirmUninstallTitle", { name: p.name || p.id }),
      hint: t("pluginsConfirmUninstallHint"),
      confirmLabel: t("pluginUninstall"),
      action: () => uninstall(p),
    });
  }

  return (
    <>
      <Show when={devMode() && trustAll()}>
        <div class="settings-warning" role="alert">
          <strong>{t("pluginTrustAll")}</strong>
          <span>{t("pluginsTrustAllBanner")}</span>
        </div>
      </Show>
      {/* Summary + filter toolbar + install action. Developer options live at
          the bottom of the selected plugin detail. */}
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
                type="button"
                aria-pressed={filter() === f.id}
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
          aria-label={t("pluginsFilterPlaceholder")}
          value={needle()}
          onInput={(e) => setNeedle(e.currentTarget.value)}
        />
        <button
          class="settings-action plg-install-btn"
          data-setting-id="action.plugin_install"
          onClick={(event) => void pickLupx(event.currentTarget)}
        >
          {t("pluginsInstall")}
        </button>
      </div>

      <div class="plg-master-detail" classList={{ "has-selection": !!selectedPlugin() }}>
        <div class="plg-list">
          <For each={visible()} fallback={<div class="plg-empty">{t("pluginsEmpty")}</div>}>
            {(p) => (
              <PluginCard
                p={p}
                open={false}
                compact
                devMode={devMode()}
                trustAll={trustAll()}
                keepSession={keepOverrides()[p.id] ?? p.keepSession}
                keepSessionOverridden={keepOverrides()[p.id] !== undefined}
                searchNeedle={(props.searchQuery ?? "").trim()}
                settingValues={values()[p.id] ?? ({} as Record<string, unknown>)}
                onToggleOpen={() => void toggleOpen(p)}
                onToggleEnabled={(v) => void toggle(p, v)}
                onToggleKeepSession={(v) => void toggleKeepSession(p, v)}
                onClearKeepSession={() => void clearKeepSession(p)}
                onReload={() => void reload(p)}
                onUninstall={() => askUninstall(p)}
                onToggleDevMode={(v) => void toggleDevMode(v)}
                onToggleTrustAll={(v) => void toggleTrustAll(v)}
                onPutSetting={(key, value) => void putSetting(p, key, value)}
              />
            )}
          </For>
        </div>
        <div class="plg-detail-pane">
          <button
            class="plg-mobile-back"
            type="button"
            onClick={() => setOpenId(null)}
          >
            ← {t("pluginsBackToList")}
          </button>
          <Show
            when={selectedPlugin()}
            fallback={<div class="plg-select-prompt">{t("pluginsSelectPrompt")}</div>}
          >
            {(p) => (
              <PluginCard
                p={p()}
                open
                devMode={devMode()}
                trustAll={trustAll()}
                keepSession={keepOverrides()[p().id] ?? p().keepSession}
                keepSessionOverridden={keepOverrides()[p().id] !== undefined}
                searchNeedle={(props.searchQuery ?? "").trim()}
                settingValues={values()[p().id] ?? ({} as Record<string, unknown>)}
                headStatic
                onToggleEnabled={(v) => void toggle(p(), v)}
                onToggleKeepSession={(v) => void toggleKeepSession(p(), v)}
                onClearKeepSession={() => void clearKeepSession(p())}
                onReload={() => void reload(p())}
                onUninstall={() => askUninstall(p())}
                onToggleDevMode={(v) => void toggleDevMode(v)}
                onToggleTrustAll={(v) => void toggleTrustAll(v)}
                onPutSetting={(key, value) => void putSetting(p(), key, value)}
              />
            )}
          </Show>
        </div>
      </div>
      <Show when={status()}>
        <span
          class="settings-status"
          classList={{ error: !status()!.ok }}
          role={status()!.ok ? "status" : "alert"}
        >
          {status()!.text}
        </span>
      </Show>
    </>
  );
}

/** The `.lupx` facts block inside the install confirm dialog: name / version
 * / kind, description, declared capabilities, payload stats and the
 * signature / overwrite notes. Plain values — it mounts with the inspected
 * package, so nothing here reads disk again. */
function InstallFacts(props: { info: LupxInfo }) {
  return (
    <div class="plg-install-facts">
      <div class="plg-install-head">
        <span class="plg-name">{props.info.name || props.info.id}</span>
        <span class="plg-ver">{props.info.version || "-"}</span>
        <span class="plg-badge">{kindLabel(props.info.kind)}</span>
      </div>
      <Show when={props.info.description}>
        <div class="plg-desc">{props.info.description}</div>
      </Show>
      <div class="plg-dsec">
        <span class="plg-dlabel">{t("pluginPermissions")}</span>
        <Show
          when={props.info.permissions.length > 0}
          fallback={<span class="plg-note">{t("pluginNoPermissions")}</span>}
        >
          <div class="plg-chiprow">
            <For each={props.info.permissions}>
              {(perm) => (
                <span class="plg-perm-chip" title={permDesc(perm)}>
                  {permLabel(perm)}
                </span>
              )}
            </For>
          </div>
        </Show>
      </div>
      <span class="plg-install-stats">
        {t("pluginsInstallStats", {
          count: String(props.info.fileCount),
          size: formatBytes(props.info.totalBytes),
        })}
      </span>
      {/* Signature status (#32.2): a verified signature is a badge, an unsigned
          package shows the archive hash for out-of-band comparison. Invalid
          signatures never reach this dialog. */}
      <Show
        when={props.info.signature === "valid"}
        fallback={
          <span class="plg-note" title={props.info.sha256}>
            {t("pluginsInstallUnsigned", { sha256: props.info.sha256.slice(0, 16) })}
          </span>
        }
      >
        <span class="plg-note ok">{t("pluginsInstallSignatureValid")}</span>
      </Show>
      {/* Overwrite notice, worded by how the package version relates to the
          installed one (Rust compares semver-ish): an upgrade is routine, a
          downgrade is the one that warns. */}
      <Show when={props.info.relation !== "fresh"}>
        <span class={"plg-note" + (props.info.relation === "downgrade" ? " warn" : "")}>
          {t(
            props.info.relation === "upgrade"
              ? "pluginsInstallUpgrade"
              : props.info.relation === "reinstall"
                ? "pluginsInstallReinstall"
                : "pluginsInstallDowngrade",
            { old: props.info.existingVersion || "-", new: props.info.version || "-" },
          )}
        </span>
      </Show>
    </div>
  );
}

/** One plugin card: icon tile + name row + description, an enable toggle
 * (plus 重载/卸载 for disk plugins) on the right, and an expandable detail
 * panel below. The header click toggles the panel; the embedded controls
 * don't — and `headStatic` drops the toggle for the detail pane's own card,
 * where leaving is the job of the list and the back button. */
function PluginCard(props: {
  p: PluginManifest;
  open: boolean;
  compact?: boolean;
  /** Global developer mode — gates 重载 and the 开发 badge (the global
   * 全部授权 switch lives in the toolbar, not per-card). */
  devMode: boolean;
  trustAll: boolean;
  /** Effective idle-reset exemption (user override ?? manifest keep_session). */
  keepSession: boolean;
  keepSessionOverridden: boolean;
  /** The global settings query, used to highlight matching declared rows. */
  searchNeedle: string;
  settingValues: Record<string, unknown>;
  /** Omitted by the detail pane's card, whose head must not toggle. */
  onToggleOpen?: () => void;
  /** Static head: no toggle role, no click/keyboard activation. */
  headStatic?: boolean;
  onToggleEnabled: (v: boolean) => void;
  onToggleKeepSession: (v: boolean) => void;
  onClearKeepSession: () => void;
  onReload: () => void;
  onUninstall: () => void;
  onToggleDevMode: (v: boolean) => void;
  onToggleTrustAll: (v: boolean) => void;
  onPutSetting: (key: string, value: unknown) => void;
}) {
  const p = () => props.p;
  const icon = () => pluginIcon(p());
  const tileChar = () => (p().name || p().id).trim().charAt(0).toUpperCase() || "·";
  const desc = () => pluginDescription(p());
  return (
    <div
      class="plg-card"
      classList={{ open: props.open, off: !p().enabled, compact: !!props.compact }}
      data-setting-id={`plugin.${p().id}`}
      tabIndex={props.compact ? -1 : undefined}
    >
      <div
        class="plg-head"
        classList={{ "plg-head-static": !!props.headStatic }}
        role={props.headStatic ? undefined : "button"}
        tabIndex={props.headStatic ? undefined : 0}
        aria-expanded={props.headStatic ? undefined : props.open}
        aria-controls={props.headStatic ? undefined : `plugin-detail-${p().id}`}
        onClick={() => {
          if (!props.headStatic) props.onToggleOpen?.();
        }}
        onKeyDown={(e) => {
          if (props.headStatic || e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            props.onToggleOpen?.();
          }
        }}
      >
        <div class="plg-tile" classList={{ [p().kind]: true }}>
          <Show when={icon()} fallback={<span class="plg-tile-letter">{tileChar()}</span>}>
            <img
              src={icon()!.src}
              alt=""
              draggable={false}
              classList={{ "icon-explicit": !icon()!.legacy }}
            />
          </Show>
        </div>
        <div class="plg-main">
          <div class="plg-name-row">
            <span class="plg-name">{p().name || p().id}</span>
            <span class="plg-ver">{p().version}</span>
            <span class="plg-badge" classList={{ builtin: p().builtin }}>
              {p().builtin ? t("pluginBuiltin") : t("pluginDisk")}
            </span>
            <Show when={p().development && props.devMode}>
              <span class="plg-badge dev">{t("pluginDev")}</span>
            </Show>
            <Show when={p().detachable}>
              <span class="plg-badge">{t("pluginDetachable")}</span>
            </Show>
            <Show when={p().kind === "mode" && p().hidden}>
              <span class="plg-badge">{t("pluginHidden")}</span>
            </Show>
          </div>
          <Show when={desc()}>
            <div class="plg-desc">{desc()}</div>
          </Show>
          <Show when={p().id === "clipboard" && !p().enabled}>
            <div class="plg-capture-note">{t("settingsClipboardPluginHint")}</div>
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
          <Show when={!p().builtin && props.devMode}>
            <button
              class="settings-icon-btn"
              type="button"
              title={t("pluginReload")}
              aria-label={`${t("pluginReload")}: ${p().name || p().id}`}
              onClick={props.onReload}
            >
              <img class="settings-icon-btn-icon" src={reloadIcon} alt="" draggable={false} />
            </button>
          </Show>
          <Show when={!p().builtin}>
            <button
              class="settings-icon-btn plg-uninstall"
              type="button"
              title={t("pluginUninstallHint")}
              aria-label={`${t("pluginUninstall")}: ${p().name || p().id}`}
              onClick={props.onUninstall}
            >
              <img class="settings-icon-btn-icon" src={deleteIcon} alt="" draggable={false} />
            </button>
          </Show>
          <Toggle
            checked={p().enabled}
            label={t("pluginToggleLabel", { name: p().name || p().id })}
            onChange={props.onToggleEnabled}
          />
          <Show when={!props.headStatic}>
            <span class="plg-chev" classList={{ open: props.open }}>▸</span>
          </Show>
        </div>
      </div>

      <Show when={props.open}>
        <div class="plg-detail" id={`plugin-detail-${p().id}`}>
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

          {/* Idle-reset exemption (docs/ROADMAP_HISTORY.md #46): the manifest `keep_session`
              is only the default — this user switch wins. Only mode pages
              hold session state worth keeping. */}
          <Show when={p().kind === "mode"}>
            <div class="plg-dsec">
              <div class="settings-row-between">
                <span class="settings-sub-label">{t("pluginKeepSession")}</span>
                <div class="settings-row">
                  <Show when={props.keepSessionOverridden}>
                    <button
                      class="settings-link"
                      type="button"
                      onClick={props.onClearKeepSession}
                    >
                      {t("pluginKeepSessionReset")}
                    </button>
                  </Show>
                  <Toggle
                    checked={props.keepSession}
                    label={`${t("pluginKeepSession")}: ${p().name || p().id}`}
                    onChange={props.onToggleKeepSession}
                  />
                </div>
              </div>
              <span class="plg-note">{t("pluginKeepSessionHint")}</span>
            </div>
          </Show>

          <Show when={p().id === "clipboard"}>
            <div class="plg-dsec">
              <span class="plg-note warn">{t("settingsClipboardPluginHint")}</span>
            </div>
          </Show>

          {/* Capabilities : what the manifest declares and the
              enforced-by-default note. The trust escape hatch is the global
              全部授权 switch in the toolbar (developer mode only) — there is
              deliberately no per-plugin trust control here anymore.
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
            </div>
          </Show>

          {/* Declared settings — the manifest describes the inputs,
              the pane renders them and writes through to the store. */}
          <Show when={p().settings.length > 0}>
            <div class="plg-dsec">
              <span class="plg-dlabel">{t("pluginSettings")}</span>
              <For each={p().settings}>
                {(s) => (
                  <SettingRow
                    pluginId={p().id}
                    setting={s}
                    value={props.settingValues[s.key]}
                    searchNeedle={props.searchNeedle}
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

          <details class="plg-dev-options">
            <summary data-setting-id="plugins.dev_mode" tabIndex={-1}>{t("pluginsDevMode")}</summary>
            <div class="settings-row-between">
              <div class="settings-setting-copy">
                <span class="settings-sub-label">{t("pluginsDevMode")}</span>
                <span class="settings-row-summary">{t("pluginsDevModeHint")}</span>
              </div>
              <Toggle
                checked={props.devMode}
                label={t("pluginsDevMode")}
                onChange={props.onToggleDevMode}
              />
            </div>
            <Show when={props.devMode}>
              <div class="settings-row-between" data-setting-id="plugins.trust_all">
                <div class="settings-setting-copy">
                  <span class="settings-sub-label warn">{t("pluginTrustAll")}</span>
                  <span class="settings-row-summary">{t("pluginsTrustAllHint")}</span>
                </div>
                <Toggle
                  checked={props.trustAll}
                  label={t("pluginTrustAll")}
                  onChange={props.onToggleTrustAll}
                />
              </div>
            </Show>
          </details>
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
  pluginId: string;
  setting: PluginSetting;
  value: unknown;
  searchNeedle: string;
  onCommit: (v: unknown) => void;
}) {
  const isToggle = () => props.setting.type === "toggle";
  const isSelect = () => props.setting.type === "select" && props.setting.options.length > 0;
  const changed = () => props.value !== undefined && props.value !== props.setting.default;
  const searchHit = () => {
    const needle = props.searchNeedle.trim().toLowerCase();
    if (!needle) return false;
    return [props.setting.label, props.setting.key, ...props.setting.options.flatMap((o) => [o.label, o.value])]
      .some((text) => text.toLowerCase().includes(needle));
  };
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
    <div
      class="plg-setting"
      classList={{ "search-hit": searchHit() }}
      data-setting-id={`plugin.${props.pluginId}.setting.${props.setting.key}`}
      tabIndex={-1}
    >
      <div class="settings-row-between">
        <span class="settings-sub-label">{props.setting.label}</span>
        <Show when={isToggle()}>
          <Toggle
            checked={props.value === true}
            label={t("pluginSettingToggleLabel", { label: props.setting.label })}
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
            aria-label={props.setting.label}
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
