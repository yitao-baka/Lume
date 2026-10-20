//! Settings window composition root — grouped navigation, command search,
//! page headers, the current pane, and the autosave/undo status bar.

import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { resolveLocale, setLocale, t } from "../i18n";
import { applyColorMode } from "../theme";
import { TitleBarControls, useChromeControls } from "../components/TitleBar";
import AppearancePane from "./AppearancePane";
import LauncherPane from "./LauncherPane";
import ClipboardPane from "./ClipboardPane";
import HotkeysPane from "./HotkeysPane";
import SearchPane from "./SearchPane";
import SystemPane from "./SystemPane";
import AutomationPane from "./AutomationPane";
import PluginsPane from "./PluginsPane";
import AboutPane from "./AboutPane";
import appearanceIcon from "../../res/icons/platte.svg";
import launcherIcon from "../../res/icons/navigate.svg";
import clipboardIcon from "../../res/icons/clipboard.svg";
import hotkeysIcon from "../../res/icons/keyboard.svg";
import searchIcon from "../../res/icons/search.svg";
import systemIcon from "../../res/icons/system.svg";
import automationIcon from "../../res/icons/automation.svg";
import pluginsIcon from "../../res/icons/plugins.svg";
import aboutIcon from "../../res/icons/about.svg";
import { diffSettings, type SettingsData, type SettingsPatch } from "./types";
import {
  buildSettingsCatalog,
  searchCatalog,
  SECTION_DESCRIPTIONS,
  SECTION_GROUPS,
  SECTION_LABELS,
  SECTION_ORDER,
  type SectionId,
  type SettingDescriptor,
} from "./catalog";
import { applySettingsSkin } from "./skin";
import type { PluginManifest } from "../plugins/types";
import { settingsError } from "./errors";
import "./skins/base.css";
import "./skins/quiet.css";
import "./skins/chromatic.css";

const SECTION_ICONS: Record<SectionId, string> = {
  appearance: appearanceIcon,
  launcher: launcherIcon,
  clipboard: clipboardIcon,
  search: searchIcon,
  hotkeys: hotkeysIcon,
  automation: automationIcon,
  plugins: pluginsIcon,
  system: systemIcon,
  about: aboutIcon,
};

type SaveState = "saved" | "saving" | "error";

interface ConfirmState {
  title: string;
  hint: string;
  confirmLabel: string;
  action: () => Promise<void>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Apply a minimal settings patch to a local snapshot. Arrays replace. */
function applyPatch(base: SettingsData, patch: SettingsPatch): SettingsData {
  const next = clone(base) as unknown as Record<string, unknown>;
  const merge = (target: Record<string, unknown>, source: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(source)) {
      const current = target[key];
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        current !== null &&
        typeof current === "object" &&
        !Array.isArray(current)
      ) {
        merge(current as Record<string, unknown>, value as Record<string, unknown>);
      } else {
        target[key] = clone(value);
      }
    }
  };
  merge(next, patch as unknown as Record<string, unknown>);
  return next as unknown as SettingsData;
}

function patchKeys(patch: SettingsPatch): string[] {
  const keys: string[] = [];
  const visit = (value: Record<string, unknown>, prefix: string) => {
    for (const [key, child] of Object.entries(value)) {
      if (child !== null && typeof child === "object" && !Array.isArray(child)) {
        visit(child as Record<string, unknown>, `${prefix}${key}.`);
      } else {
        keys.push(`${prefix}${key}`);
      }
    }
  };
  visit(patch as unknown as Record<string, unknown>, "");
  return keys;
}

function saveDelayFor(patch: SettingsPatch): number {
  const keys = patchKeys(patch);
  if (
    keys.some(
      (key) =>
        key.endsWith("search_placeholder_apps") ||
        key.endsWith("search_placeholder_clipboard"),
    )
  ) {
    return 500;
  }
  if (
    keys.some(
      (key) =>
        key.endsWith("merge_window_ms") ||
        key.endsWith("cache_refresh_interval_minutes"),
    )
  ) {
    return 200;
  }
  return 0;
}

function sectionNumber(section: SectionId): string {
  return String(SECTION_ORDER.indexOf(section) + 1).padStart(2, "0");
}

function highlightMatch(text: string, query: string) {
  const needle = query.trim();
  if (!needle) return text;
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + needle.length)}</mark>
      {text.slice(index + needle.length)}
    </>
  );
}

export default function Settings() {
  const [section, setSection] = createSignal<SectionId>("appearance");
  const [query, setQuery] = createSignal("");
  const [searchFocused, setSearchFocused] = createSignal(false);
  const [selectedResult, setSelectedResult] = createSignal(0);
  const [settings, setSettings] = createSignal<SettingsData | null>(null);
  const [baseline, setBaseline] = createSignal<SettingsData | null>(null);
  const [plugins, setPlugins] = createSignal<PluginManifest[]>([]);
  const [pluginDeepQuery, setPluginDeepQuery] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [saveState, setSaveState] = createSignal<SaveState>("saved");
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [skinError, setSkinError] = createSignal<string | null>(null);
  const [lastUndo, setLastUndo] = createSignal<{
    before: SettingsData;
    after: SettingsData;
  } | null>(null);
  const [confirmState, setConfirmState] = createSignal<ConfirmState | null>(null);
  const [confirmBusy, setConfirmBusy] = createSignal(false);
  const [confirmError, setConfirmError] = createSignal<string | null>(null);
  const [bodyCue, setBodyCue] = createSignal({ above: false, below: false });

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saveChain: Promise<boolean> = Promise.resolve(true);
  let failedSnapshot: SettingsData | null = null;
  let selfWriteUntil = 0;
  let undoTimer: ReturnType<typeof setTimeout> | undefined;
  let loadSeq = 0;
  let bodyEl: HTMLDivElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  let contentEl: HTMLDivElement | undefined;
  let topbarEl: HTMLElement | undefined;
  let footerEl: HTMLElement | undefined;
  let dialogEl: HTMLDivElement | undefined;
  let confirmCancelButton: HTMLButtonElement | undefined;
  let previousFocus: HTMLElement | null = null;
  let dialogWasOpen = false;
  let bodyRaf = 0;

  const chrome = useChromeControls();
  const catalog = createMemo(() => {
    const value = settings();
    return value ? buildSettingsCatalog(value, plugins()) : [];
  });
  const results = createMemo(() => searchCatalog(catalog(), query()).slice(0, 12));
  const searchOpen = () => query().trim().length > 0 && searchFocused();
  const currentIndex = () => {
    const list = results();
    if (list.length === 0) return 0;
    return Math.min(selectedResult(), list.length - 1);
  };
  function measureBodyCue() {
    const el = bodyEl;
    if (!el) return;
    const above = el.scrollTop > 1;
    const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    const previous = bodyCue();
    if (previous.above !== above || previous.below !== below) setBodyCue({ above, below });
  }

  function scheduleBodyCue() {
    cancelAnimationFrame(bodyRaf);
    bodyRaf = requestAnimationFrame(measureBodyCue);
  }

  function activeTextEditor(): boolean {
    const active = document.activeElement as HTMLElement | null;
    if (!active || !contentEl?.contains(active)) return false;
    return (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active.isContentEditable
    );
  }

  function loadSettings(force = false) {
    if (!force && (saveState() === "saving" || saveTimer || saveState() === "error")) return;
    if (!force && activeTextEditor()) return;
    const sequence = ++loadSeq;
    if (!settings()) setLoading(true);
    setLoadError(null);
    void invoke<SettingsData>("get_settings")
      .then((loaded) => {
        if (sequence !== loadSeq) return;
        const normalized = clone(loaded);
        batch(() => {
          setSettings(normalized);
          setBaseline(clone(normalized));
          setSaveState("saved");
          setSaveError(null);
          setSkinError(null);
          setLastUndo(null);
          failedSnapshot = null;
          applySettingsSkin(normalized.appearance.settings_skin);
        });
      })
      .catch((error) => {
        if (sequence === loadSeq) setLoadError(settingsError(error, "settingsLoadFailed"));
      })
      .finally(() => {
        if (sequence === loadSeq) setLoading(false);
      });
  }

  function queueSave(patch: SettingsPatch) {
    failedSnapshot = null;
    setSaveError(null);
    setSkinError(null);
    setSaveState("saving");
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      void saveNow();
    }, saveDelayFor(patch));
  }

  async function performSave(): Promise<boolean> {
    const draft = settings();
    const base = baseline();
    if (!draft || !base) return true;
    const patch = diffSettings(
      base as unknown as Record<string, unknown>,
      draft as unknown as Record<string, unknown>,
    );
    if (Object.keys(patch).length === 0) {
      setSaveState("saved");
      return true;
    }
    const snapshot = clone(draft);
    setSaveState("saving");
    setSaveError(null);
    try {
      selfWriteUntil = Date.now() + 1500;
      await invoke("save_settings_patch", { patch });
      batch(() => {
        setBaseline(clone(snapshot));
        setSaveState("saved");
        setLastUndo({ before: clone(base), after: clone(snapshot) });
      });
      if (undoTimer) clearTimeout(undoTimer);
      undoTimer = setTimeout(() => setLastUndo(null), 6000);
      return true;
    } catch (error) {
      failedSnapshot = snapshot;
      const message = settingsError(error, "settingsSaveFailed");
      batch(() => {
        setSaveState("error");
        setSaveError(message);
        if (patchKeys(patch).includes("appearance.settings_skin")) {
          setSkinError(t("settingsSkinSaveFailed"));
        }
        setSettings(clone(base));
        applySettingsSkin(base.appearance.settings_skin);
      });
      return false;
    }
  }

  function saveNow(): Promise<boolean> {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    const task = saveChain.then(() => performSave());
    saveChain = task.catch(() => false);
    return task;
  }

  async function retrySave() {
    if (!failedSnapshot) {
      await saveNow();
      return;
    }
    const snapshot = failedSnapshot;
    failedSnapshot = null;
    setSettings(clone(snapshot));
    applySettingsSkin(snapshot.appearance.settings_skin);
    setSaveState("saving");
    await saveNow();
  }

  function commitAppearance(patch: Partial<SettingsData["appearance"]>) {
    const current = settings();
    if (!current) return;
    const focusBefore = document.activeElement as HTMLElement | null;
    const scrollBefore = bodyEl?.scrollTop ?? 0;
    if (patch.settings_skin) applySettingsSkin(patch.settings_skin);
    setSettings({ ...current, appearance: { ...current.appearance, ...patch } });
    queueSave({ appearance: patch } as SettingsPatch);
    if (patch.settings_skin) {
      const restoreSkinFocus = () => {
        if (bodyEl) bodyEl.scrollTop = scrollBefore;
        const currentSelected = document.querySelector<HTMLElement>(
          '[data-setting-id="appearance.settings_skin"] [role="radio"][aria-checked="true"]',
        );
        const target = focusBefore?.isConnected ? focusBefore : currentSelected;
        target?.focus({ preventScroll: true });
      };
      requestAnimationFrame(restoreSkinFocus);
      setTimeout(restoreSkinFocus, 120);
    }
  }

  function commitClipboard(patch: Partial<SettingsData["clipboard"]>) {
    const current = settings();
    if (!current) return;
    setSettings({ ...current, clipboard: { ...current.clipboard, ...patch } });
    queueSave({ clipboard: patch } as SettingsPatch);
  }

  function commitHotkeys(patch: Partial<SettingsData["hotkeys"]>) {
    const current = settings();
    if (!current) return;
    setSettings({ ...current, hotkeys: { ...current.hotkeys, ...patch } });
    queueSave({ hotkeys: patch } as SettingsPatch);
  }

  function commitIndex(patch: Partial<SettingsData["index"]>) {
    const current = settings();
    if (!current) return;
    setSettings({ ...current, index: { ...current.index, ...patch } });
    queueSave({ index: patch } as SettingsPatch);
  }

  function commitAutomation(patch: Partial<SettingsData["automation"]>) {
    const current = settings();
    if (!current) return;
    setSettings({ ...current, automation: { ...current.automation, ...patch } });
    queueSave({ automation: patch } as SettingsPatch);
  }

  function undoLast() {
    const undo = lastUndo();
    const current = settings();
    if (!undo || !current) return;
    const inverse = diffSettings(
      undo.after as unknown as Record<string, unknown>,
      undo.before as unknown as Record<string, unknown>,
    );
    const next = applyPatch(current, inverse);
    setLastUndo(null);
    if (undoTimer) clearTimeout(undoTimer);
    setSettings(next);
    applySettingsSkin(next.appearance.settings_skin);
    queueSave(inverse);
  }

  function navigateTo(next: SectionId) {
    setSection(next);
    setQuery("");
    setPluginDeepQuery("");
    setSelectedResult(0);
    requestAnimationFrame(() => {
      if (bodyEl) bodyEl.scrollTop = 0;
      scheduleBodyCue();
    });
  }

  function jumpToResult(result: SettingDescriptor) {
    setSection(result.section);
    if (result.id.startsWith("plugin.")) {
      const parts = result.id.split(".");
      setPluginDeepQuery(parts[2] === "setting" ? parts[3] ?? "" : parts[1] ?? "");
    } else if (result.id === "plugins.dev_mode" || result.id === "plugins.trust_all") {
      setPluginDeepQuery(plugins()[0]?.id ?? "");
    } else {
      setPluginDeepQuery("");
    }
    setQuery("");
    setSearchFocused(false);
    let attempts = 0;
    const focusTarget = () => {
      const exact = document.querySelector<HTMLElement>(
        `[data-setting-id="${CSS.escape(result.id)}"]`,
      );
      const target = exact ?? document.querySelector<HTMLElement>("#settings-page-content");
      if (!exact && result.id.startsWith("plugin.") && attempts++ < 15) {
        setTimeout(focusTarget, 100);
        return;
      }
      target?.scrollIntoView({ block: "center" });
      target?.focus({ preventScroll: true });
      if (target) {
        target.classList.add("settings-jump-highlight");
        setTimeout(() => target.classList.remove("settings-jump-highlight"), 1600);
      }
      scheduleBodyCue();
    };
    requestAnimationFrame(() => requestAnimationFrame(focusTarget));
  }

  function moveSearchSelection(delta: number) {
    const count = results().length;
    if (count === 0) return;
    setSelectedResult((current) => (current + delta + count) % count);
  }

  function closeWindow() {
    void invoke("close_settings").catch(() => undefined);
  }

  async function requestClose() {
    if (saveState() === "error") {
      document.querySelector<HTMLButtonElement>(".settings-retry-status")?.focus();
      return;
    }
    if (!(await saveNow())) return;
    closeWindow();
  }

  function openConfirm(next: ConfirmState, trigger?: HTMLElement) {
    previousFocus = trigger ?? (document.activeElement as HTMLElement | null);
    setConfirmError(null);
    setConfirmState(next);
  }

  function closeConfirm() {
    if (confirmBusy()) return;
    setConfirmState(null);
    setConfirmError(null);
  }

  async function runConfirm() {
    const state = confirmState();
    if (!state || confirmBusy()) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      await state.action();
      setConfirmState(null);
    } catch (error) {
      setConfirmError(settingsError(error));
    } finally {
      setConfirmBusy(false);
    }
  }

  function askRestoreDefaults(trigger?: HTMLElement) {
    openConfirm(
      {
        title: t("settingsRestoreDefaultTitle"),
        hint: t("settingsRestoreDefaultsHintLong"),
        confirmLabel: t("settingsRestoreDefault"),
        action: async () => {
          if (!(await saveNow())) throw new Error(t("settingsSaveFailed"));
          await invoke("restore_default");
          const loaded = await invoke<SettingsData>("get_settings");
          batch(() => {
            setSettings(clone(loaded));
            setBaseline(clone(loaded));
            setSaveState("saved");
            setSaveError(null);
            setSkinError(null);
            setLastUndo(null);
            applySettingsSkin(loaded.appearance.settings_skin);
          });
        },
      },
      trigger,
    );
  }
  onMount(() => {
    loadSettings(true);
    void invoke<PluginManifest[]>("get_plugins")
      .then(setPlugins)
      .catch((error) => console.error("[settings] plugin search index", error));

    let disposed = false;
    let unlistenFocus: (() => void) | undefined;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused && saveState() !== "error" && !saveTimer) loadSettings();
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenFocus = unlisten;
      });

    let unlistenClose: (() => void) | undefined;
    void listen("settings-close-requested", () => void requestClose()).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenClose = unlisten;
    });

    let unlistenApplied: (() => void) | undefined;
    void listen("settings-applied", () => {
      if (Date.now() >= selfWriteUntil && saveState() !== "saving" && !saveTimer) loadSettings();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenApplied = unlisten;
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInput?.focus();
        searchInput?.select();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (topbarEl?.querySelector(".settings-search")?.contains(target)) return;
      setSearchFocused(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);

    bodyEl?.addEventListener("scroll", scheduleBodyCue, { passive: true });
    const resize = new ResizeObserver(scheduleBodyCue);
    if (bodyEl) resize.observe(bodyEl);
    const mutation = new MutationObserver(scheduleBodyCue);
    if (bodyEl) mutation.observe(bodyEl, { childList: true, subtree: true });
    scheduleBodyCue();

    onCleanup(() => {
      disposed = true;
      unlistenFocus?.();
      unlistenClose?.();
      unlistenApplied?.();
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
      bodyEl?.removeEventListener("scroll", scheduleBodyCue);
      resize.disconnect();
      mutation.disconnect();
      cancelAnimationFrame(bodyRaf);
      if (saveTimer) clearTimeout(saveTimer);
      if (undoTimer) clearTimeout(undoTimer);
    });
  });

  createEffect(() => {
    const value = settings();
    if (!value) return;
    setLocale(resolveLocale(value.appearance.language));
    applyColorMode(value.appearance.color_mode);
    applySettingsSkin(value.appearance.settings_skin);
    document.documentElement.dataset.settingsSaveState = saveState();
  });

  createEffect(() => {
    section();
    query();
    settings();
    requestAnimationFrame(scheduleBodyCue);
  });

  createEffect(() => {
    const open = !!confirmState();
    for (const element of [topbarEl, contentEl, footerEl]) {
      if (!element) continue;
      element.toggleAttribute("inert", open);
      if (open) element.setAttribute("aria-hidden", "true");
      else element.removeAttribute("aria-hidden");
    }
    if (open) {
      requestAnimationFrame(() => confirmCancelButton?.focus());
    } else if (dialogWasOpen) {
      const trigger = previousFocus;
      previousFocus = null;
      requestAnimationFrame(() => trigger?.focus());
    }
    dialogWasOpen = open;
  });

  function onDialogKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeConfirm();
      return;
    }
    if (event.key !== "Tab" || !dialogEl) return;
    const focusable = Array.from(
      dialogEl.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialogEl.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialogEl.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }
  return (
    <div class="settings" data-save-state={saveState()}>
      <header class="settings-topbar" data-tauri-drag-region ref={(el) => (topbarEl = el)}>
        <div class="settings-brand" data-tauri-drag-region>
          <span class="settings-brand-mark" aria-hidden="true">L</span>
          <span class="settings-brand-copy" data-tauri-drag-region>
            <strong>LUME</strong>
            <small>{t("settingsTopbarSubtitle")}</small>
          </span>
        </div>
        <div class="settings-search">
          <img class="settings-search-icon" src={searchIcon} alt="" draggable={false} />
          <input
            ref={(el) => (searchInput = el)}
            class="settings-search-input"
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={searchOpen()}
            aria-controls="settings-search-results"
            aria-activedescendant={
              searchOpen() && results()[currentIndex()]
                ? `settings-search-result-${currentIndex()}`
                : undefined
            }
            placeholder={t("searchSettings")}
            aria-label={t("searchSettings")}
            autocomplete="off"
            spellcheck={false}
            value={query()}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setSelectedResult(0);
              setSearchFocused(true);
            }}
            onFocus={() => setSearchFocused(true)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveSearchSelection(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveSearchSelection(-1);
              } else if (event.key === "Enter" && searchOpen() && results().length > 0) {
                event.preventDefault();
                jumpToResult(results()[currentIndex()]);
              } else if (event.key === "Escape" && searchOpen()) {
                event.preventDefault();
                setQuery("");
                setSearchFocused(false);
              }
            }}
          />
          <kbd class="settings-search-shortcut" aria-hidden="true">Ctrl F</kbd>
          <Show when={searchOpen()}>
            <div
              id="settings-search-results"
              class="settings-search-results"
              role="listbox"
              aria-label={t("settingsSearchResults")}
            >
              <Show
                when={results().length > 0}
                fallback={
                  <div class="settings-search-empty" role="status">
                    <p>{t("settingsNoMatches")}</p>
                    <span>{t("settingsSearchSuggestions")}</span>
                  </div>
                }
              >
                <For each={results()}>
                  {(result, index) => (
                    <button
                      id={`settings-search-result-${index()}`}
                      class="settings-search-result"
                      classList={{ active: currentIndex() === index() }}
                      type="button"
                      role="option"
                      aria-selected={currentIndex() === index()}
                      onMouseEnter={() => setSelectedResult(index())}
                      onClick={() => jumpToResult(result)}
                    >
                      <span class="settings-result-main">
                        <span class="settings-result-label">
                          {highlightMatch(result.label, query())}
                        </span>
                        <span class="settings-result-path">{result.path}</span>
                      </span>
                      <span class="settings-result-value">
                        {result.summary ? highlightMatch(result.summary, query()) : result.value}
                      </span>
                    </button>
                  )}
                </For>
              </Show>
            </div>
          </Show>
        </div>
        <TitleBarControls controls={chrome} onClose={() => void requestClose()} />
      </header>

      <div class="settings-content" ref={(el) => (contentEl = el)}>
        <aside class="settings-sidebar" role="tablist" aria-label={t("settings")}>
          <For each={SECTION_GROUPS}>
            {(group) => (
              <div class="settings-nav-group" data-group={group.id}>
                <span class="settings-nav-group-label">{t(group.labelKey)}</span>
                <For each={group.sections}>
                  {(id) => (
                    <button
                      class="settings-nav"
                      classList={{ active: section() === id }}
                      type="button"
                      id={`settings-tab-${id}`}
                      data-section={id}
                      role="tab"
                      aria-selected={section() === id}
                      aria-controls="settings-active-panel"
                      title={t(SECTION_LABELS[id])}
                      tabIndex={section() === id ? 0 : -1}
                      onClick={() => navigateTo(id)}
                      onKeyDown={(event) => {
                        const index = SECTION_ORDER.indexOf(id);
                        let next = -1;
                        if (event.key === "ArrowDown" || event.key === "ArrowRight") {
                          next = (index + 1) % SECTION_ORDER.length;
                        } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
                          next = (index - 1 + SECTION_ORDER.length) % SECTION_ORDER.length;
                        } else if (event.key === "Home") {
                          next = 0;
                        } else if (event.key === "End") {
                          next = SECTION_ORDER.length - 1;
                        }
                        if (next < 0) return;
                        event.preventDefault();
                        const target = SECTION_ORDER[next];
                        navigateTo(target);
                        requestAnimationFrame(() =>
                          document.getElementById(`settings-tab-${target}`)?.focus(),
                        );
                      }}
                    >
                      <img class="settings-nav-icon" src={SECTION_ICONS[id]} alt="" draggable={false} />
                      <span class="settings-nav-label">{t(SECTION_LABELS[id])}</span>
                      <span class="settings-nav-index" aria-hidden="true">{sectionNumber(id)}</span>
                    </button>
                  )}
                </For>
              </div>
            )}
          </For>
          <div class="settings-nav-watermark" aria-hidden="true">
            <strong>{sectionNumber(section())}</strong>
            <span>/ 09</span>
          </div>
        </aside>

        <main
          class="settings-main"
          id="settings-active-panel"
          role="tabpanel"
          aria-labelledby={`settings-tab-${section()}`}
        >
          <div class="settings-body" ref={(el) => (bodyEl = el)} onScroll={scheduleBodyCue}>
            <Show
              when={settings()}
              fallback={
                <div class="settings-load-state">
                  <Show
                    when={loadError()}
                    fallback={
                      <span class="settings-hint" role="status">
                        {t(loading() ? "settingsLoading" : "settingsLoadFailed")}
                      </span>
                    }
                  >
                    <span class="settings-inline-error" role="alert">{loadError()}</span>
                    <button class="settings-action" type="button" onClick={() => loadSettings(true)}>
                      {t("settingsRetry")}
                    </button>
                  </Show>
                </div>
              }
            >
              <header class="settings-page-header">
                <div class="settings-page-eyebrow">
                  <span class="settings-eyebrow-mark" aria-hidden="true" />
                  <span>{t(SECTION_LABELS[section()])}</span>
                </div>
                <div class="settings-page-title-row">
                  <h1>{t(SECTION_LABELS[section()])}</h1>
                  <span class="settings-page-number" aria-hidden="true">
                    {sectionNumber(section())}
                  </span>
                </div>
                <p>{t(SECTION_DESCRIPTIONS[section()])}</p>
                <span class="settings-page-accent" aria-hidden="true" />
              </header>
              <Show when={saveState() === "error" && saveError()}>
                <div class="settings-save-banner" role="alert">
                  <span>{saveError()}</span>
                  <button class="settings-link" type="button" onClick={() => void retrySave()}>
                    {t("settingsSaveRetry")}
                  </button>
                </div>
              </Show>
              <div id="settings-page-content" tabIndex={-1} class="settings-page-content">
                <SectionBody
                  section={section()}
                  settings={settings()!}
                  onUpdateAppearance={commitAppearance}
                  onUpdateHotkeys={commitHotkeys}
                  onUpdateIndex={commitIndex}
                  onUpdateClipboard={commitClipboard}
                  onUpdateAutomation={commitAutomation}
                  onReload={() => loadSettings(true)}
                  confirmDiscard={async () => (await saveNow()) && saveState() !== "error"}
                  pluginSearchQuery={pluginDeepQuery()}
                  skinError={skinError()}
                  onNavigate={navigateTo}
                  requestConfirm={openConfirm}
                  clipboardPluginEnabled={
                    plugins().find((plugin) => plugin.id === "clipboard")?.enabled ?? true
                  }
                />
              </div>
            </Show>
          </div>
          <Show when={bodyCue().above}>
            <div class="scroll-fade top" aria-hidden="true" />
          </Show>
          <Show when={bodyCue().below}>
            <div class="scroll-fade bottom" aria-hidden="true" />
          </Show>
        </main>
      </div>
      <footer class="settings-footer" ref={(el) => (footerEl = el)}>
        <Show
          when={saveState() === "error"}
          fallback={
            <span class="settings-save-status" role="status" aria-live="polite">
              <span class="settings-save-symbol" aria-hidden="true">
                {saveState() === "saving" ? "" : "✓"}
              </span>
              {t(saveState() === "saving" ? "settingsSaving" : "settingsAutoSaved")}
            </span>
          }
        >
          <button
            class="settings-save-status settings-retry-status"
            type="button"
            onClick={() => void retrySave()}
          >
            <span class="settings-save-symbol" aria-hidden="true">!</span>
            {t("settingsSaveFailedStatus")}
          </button>
        </Show>
        <span class="settings-footer-spacer" />
        <Show when={lastUndo()}>
          <button class="settings-footer-action" type="button" onClick={undoLast}>
            {t("settingsUndo")}
          </button>
        </Show>
        <button
          class="settings-footer-action"
          type="button"
          data-setting-id="system.restore_default"
          onClick={(event) => askRestoreDefaults(event.currentTarget)}
        >
          {t("settingsRestoreDefault")}
        </button>
        <span class="settings-footer-page" aria-hidden="true">{sectionNumber(section())} / 09</span>
      </footer>

      <Show when={confirmState()}>
        <div class="settings-confirm-overlay" onClick={closeConfirm} />
        <div
          class="settings-confirm"
          ref={(el) => (dialogEl = el)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-confirm-title"
          aria-describedby="settings-confirm-hint"
          onKeyDown={onDialogKeyDown}
        >
          <p class="settings-confirm-title" id="settings-confirm-title">
            {confirmState()!.title}
          </p>
          <p class="settings-confirm-hint" id="settings-confirm-hint">
            {confirmState()!.hint}
          </p>
          <Show when={confirmError()}>
            <span class="settings-inline-error" role="alert">{confirmError()}</span>
          </Show>
          <div class="settings-confirm-actions">
            <button
              class="settings-action settings-action-primary"
              type="button"
              disabled={confirmBusy()}
              onClick={() => void runConfirm()}
            >
              {confirmState()!.confirmLabel}
            </button>
            <button
              class="settings-action"
              type="button"
              ref={(el) => (confirmCancelButton = el)}
              disabled={confirmBusy()}
              onClick={closeConfirm}
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}

function SectionBody(props: {
  section: SectionId;
  settings: SettingsData;
  onUpdateAppearance: (patch: Partial<SettingsData["appearance"]>) => void;
  onUpdateHotkeys: (patch: Partial<SettingsData["hotkeys"]>) => void;
  onUpdateIndex: (patch: Partial<SettingsData["index"]>) => void;
  onUpdateClipboard: (patch: Partial<SettingsData["clipboard"]>) => void;
  onUpdateAutomation: (patch: Partial<SettingsData["automation"]>) => void;
  onReload: () => void;
  confirmDiscard: () => Promise<boolean>;
  pluginSearchQuery: string;
  skinError: string | null;
  onNavigate: (section: SectionId) => void;
  requestConfirm: (state: ConfirmState) => void;
  clipboardPluginEnabled: boolean;
}) {
  return (
    <Switch>
      <Match when={props.section === "appearance"}>
        <AppearancePane
          settings={props.settings}
          onChange={props.onUpdateAppearance}
          skinError={props.skinError}
        />
      </Match>
      <Match when={props.section === "launcher"}>
        <LauncherPane settings={props.settings} onChange={props.onUpdateAppearance} />
      </Match>
      <Match when={props.section === "clipboard"}>
        <ClipboardPane
          settings={props.settings}
          onChange={props.onUpdateClipboard}
          pluginEnabled={props.clipboardPluginEnabled}
          onOpenPlugins={() => props.onNavigate("plugins")}
        />
      </Match>
      <Match when={props.section === "search"}>
        <SearchPane settings={props.settings} onChangeIndex={props.onUpdateIndex} />
      </Match>
      <Match when={props.section === "hotkeys"}>
        <HotkeysPane settings={props.settings} onChangeHotkeys={props.onUpdateHotkeys} />
      </Match>
      <Match when={props.section === "automation"}>
        <AutomationPane
          settings={props.settings}
          onChange={props.onUpdateAutomation}
          onOpenSystem={() => props.onNavigate("system")}
        />
      </Match>
      <Match when={props.section === "plugins"}>
        <PluginsPane
          searchQuery={props.pluginSearchQuery}
          requestConfirm={props.requestConfirm}
        />
      </Match>
      <Match when={props.section === "system"}>
        <SystemPane
          settings={props.settings}
          onReload={props.onReload}
          confirmDiscard={props.confirmDiscard}
          requestConfirm={props.requestConfirm}
        />
      </Match>
      <Match when={props.section === "about"}>
        <AboutPane />
      </Match>
    </Switch>
  );
}
