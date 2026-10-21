//! Single settings catalog used by the command-search palette and page
//! jump/focus plumbing. Labels, summaries and help text stay localized;
//! keyword arrays carry English keys and synonyms so technical values remain
//! searchable in every locale.

import { t, type Messages } from "../i18n";
import type { PluginManifest } from "../plugins/types";
import type { SettingsData } from "./types";

export type SectionId =
  | "appearance"
  | "launcher"
  | "clipboard"
  | "search"
  | "hotkeys"
  | "automation"
  | "plugins"
  | "system"
  | "about";

export type SettingKind =
  | "switch"
  | "segmented"
  | "number"
  | "text"
  | "editor"
  | "action"
  | "palette";

export interface SettingDescriptor {
  id: string;
  section: SectionId;
  path: string;
  label: string;
  summary?: string;
  details: string[];
  keywords: string[];
  kind: SettingKind;
  value: string;
}

export const SECTION_ORDER: SectionId[] = [
  "appearance",
  "launcher",
  "clipboard",
  "search",
  "hotkeys",
  "automation",
  "plugins",
  "system",
  "about",
];

export const SECTION_GROUPS: {
  id: "personal" | "efficiency" | "manage";
  labelKey: keyof Messages;
  sections: SectionId[];
}[] = [
  {
    id: "personal",
    labelKey: "settingsGroupPersonal",
    sections: ["appearance", "launcher", "clipboard"],
  },
  {
    id: "efficiency",
    labelKey: "settingsGroupEfficiency",
    sections: ["search", "hotkeys", "automation"],
  },
  {
    id: "manage",
    labelKey: "settingsGroupManage",
    sections: ["plugins", "system", "about"],
  },
];

export const SECTION_LABELS: Record<SectionId, keyof Messages> = {
  appearance: "navAppearance",
  launcher: "navLauncher",
  clipboard: "clipboard",
  search: "navSearch",
  hotkeys: "navHotkeys",
  automation: "automation",
  plugins: "plugins",
  system: "system",
  about: "about",
};

export const SECTION_DESCRIPTIONS: Record<SectionId, keyof Messages> = {
  appearance: "settingsAppearancePageDesc",
  launcher: "settingsLauncherPageDesc",
  clipboard: "settingsClipboardPageDesc",
  search: "settingsSearchPageDesc",
  hotkeys: "settingsHotkeysPageDesc",
  automation: "settingsAutomationPageDesc",
  plugins: "settingsPluginsPageDesc",
  system: "settingsSystemPageDesc",
  about: "settingsAboutPageDesc",
};

type DescriptorInput = Omit<
  SettingDescriptor,
  "path" | "label" | "summary" | "details"
> & {
  labelKey: keyof Messages;
  summaryKey?: keyof Messages;
  detailKeys?: (keyof Messages)[];
  groupKey?: keyof Messages;
};

function onOff(value: boolean): string {
  return t(value ? "settingsValueOn" : "settingsValueOff");
}

function descriptor(input: DescriptorInput): SettingDescriptor {
  const sectionLabel = t(SECTION_LABELS[input.section]);
  const group = input.groupKey ? t(input.groupKey) : "";
  return {
    id: input.id,
    section: input.section,
    path: group ? `${sectionLabel} › ${group}` : sectionLabel,
    label: t(input.labelKey),
    summary: input.summaryKey ? t(input.summaryKey) : undefined,
    details: (input.detailKeys ?? []).map((key) => t(key)),
    keywords: input.keywords,
    kind: input.kind,
    value: input.value,
  };
}

/** Build the localized catalog from the live settings snapshot. Dynamic plugin
 * declarations are appended so their labels/options participate in the same
 * ranking as static fields. */
export function buildSettingsCatalog(
  settings: SettingsData,
  plugins: PluginManifest[] = [],
): SettingDescriptor[] {
  const a = settings.appearance;
  const c = settings.clipboard;
  const i = settings.index;
  const h = settings.hotkeys;
  const au = settings.automation;
  const entries: SettingDescriptor[] = [
    descriptor({
      id: "appearance.language",
      section: "appearance",
      labelKey: "settingsLanguage",
      summaryKey: "settingsLanguageHint",
      groupKey: "groupAppearanceLanguage",
      kind: "segmented",
      keywords: ["language", "locale", "语言", "語言", "English", "中文"],
      value: a.language,
    }),
    descriptor({
      id: "appearance.color_mode",
      section: "appearance",
      labelKey: "settingsColorMode",
      summaryKey: "settingsColorModeHint",
      groupKey: "groupAppearanceTheme",
      detailKeys: ["settingsColorModeDetail"],
      kind: "segmented",
      keywords: [
        "theme",
        "dark",
        "light",
        "system",
        "solar",
        "lunar",
        "主题",
        "深色",
        "浅色",
        "日之耀面",
        "月之暗面",
      ],
      value: a.color_mode,
    }),
    descriptor({
      id: "appearance.settings_skin",
      section: "appearance",
      labelKey: "settingsSkin",
      summaryKey: "settingsSkinHint",
      groupKey: "groupAppearanceSkin",
      detailKeys: ["settingsSkinDetail"],
      kind: "segmented",
      keywords: ["skin", "theme", "style", "quiet", "chromatic", "皮肤", "主題", "风格"],
      value: a.settings_skin,
    }),
    descriptor({
      id: "appearance.settings_accent",
      section: "appearance",
      labelKey: "settingsAccent",
      summaryKey: "settingsAccentHint",
      groupKey: "groupAppearanceAccent",
      detailKeys: ["settingsAccentDetail"],
      kind: "palette",
      keywords: [
        "color",
        "accent",
        "palette",
        "theme",
        "主题色",
        "強調色",
        "调色盘",
        "調色盤",
        "配色",
      ],
      value: a.settings_accent || t("settingsAccentDefault"),
    }),
    descriptor({
      id: "appearance.window_width",
      section: "launcher",
      labelKey: "settingsWidth",
      groupKey: "groupWindow",
      kind: "segmented",
      keywords: ["width", "size", "launcher", "宽度", "寬度"],
      value: `${a.window_width}px`,
    }),
    descriptor({
      id: "appearance.window_height",
      section: "launcher",
      labelKey: "settingsHeight",
      summaryKey: "settingsHeightHint",
      groupKey: "groupWindow",
      kind: "segmented",
      keywords: ["height", "max", "content", "高度", "內容"],
      value: `${a.window_height}px`,
    }),
    descriptor({
      id: "appearance.window_position",
      section: "launcher",
      labelKey: "settingsWindowPosition",
      summaryKey: "settingsWindowPositionHint",
      groupKey: "groupWindow",
      detailKeys: ["settingsWindowPositionDetail"],
      kind: "segmented",
      keywords: ["position", "center", "corner", "mouse", "manual", "位置", "鼠标"],
      value: a.remember_position ? t("settingsCustom") : a.window_position,
    }),
    descriptor({
      id: "appearance.show_recent",
      section: "launcher",
      labelKey: "showRecent",
      summaryKey: "settingsShowRecentHint",
      groupKey: "groupNavBar",
      kind: "switch",
      keywords: ["recent", "history", "最近", "最近使用"],
      value: onOff(a.show_recent),
    }),
    descriptor({
      id: "appearance.show_explorer_bar",
      section: "launcher",
      labelKey: "showExplorerBar",
      summaryKey: "settingsShowExplorerHint",
      groupKey: "groupNavBar",
      kind: "switch",
      keywords: ["explorer", "folder", "资源管理器", "資料夾"],
      value: onOff(a.show_explorer_bar),
    }),
    descriptor({
      id: "appearance.expand_pinned",
      section: "launcher",
      labelKey: "expandPinned",
      summaryKey: "settingsExpandPinnedHint",
      groupKey: "groupNavBar",
      kind: "switch",
      keywords: ["pinned", "expand", "固定", "展開"],
      value: onOff(a.expand_pinned),
    }),
    descriptor({
      id: "appearance.mode_switch_icons_only",
      section: "launcher",
      labelKey: "modeSwitchIconsOnly",
      summaryKey: "settingsModeIconsHint",
      groupKey: "groupNavBar",
      kind: "switch",
      keywords: ["mode", "icon", "pill", "模式", "图标"],
      value: onOff(a.mode_switch_icons_only),
    }),
    descriptor({
      id: "appearance.shift_enter_admin",
      section: "launcher",
      labelKey: "shiftEnterAdmin",
      summaryKey: "settingsShiftEnterHint",
      groupKey: "groupNavBar",
      detailKeys: ["settingsShiftEnterDetail"],
      kind: "switch",
      keywords: ["admin", "uac", "administrator", "管理员", "管理員"],
      value: onOff(a.shift_enter_admin),
    }),
    descriptor({
      id: "appearance.remember_last_page",
      section: "launcher",
      labelKey: "rememberLastPage",
      summaryKey: "settingsRememberPageHint",
      groupKey: "groupSession",
      kind: "switch",
      keywords: ["session", "page", "restart", "页面", "重啟"],
      value: onOff(a.remember_last_page),
    }),
    descriptor({
      id: "appearance.per_mode_query",
      section: "launcher",
      labelKey: "perModeQuery",
      summaryKey: "settingsPerModeQuerySummary",
      groupKey: "groupSession",
      detailKeys: ["perModeQueryHint"],
      kind: "switch",
      keywords: ["query", "search", "mode", "搜索词", "模式"],
      value: onOff(a.per_mode_query),
    }),
    descriptor({
      id: "appearance.idle_reset_enabled",
      section: "launcher",
      labelKey: "idleReset",
      summaryKey: "settingsIdleResetSummary",
      groupKey: "groupSession",
      detailKeys: ["idleResetHint"],
      kind: "switch",
      keywords: ["idle", "reset", "session", "闲置", "閒置", "重置"],
      value: onOff(a.idle_reset_enabled),
    }),
    descriptor({
      id: "appearance.idle_reset_minutes",
      section: "launcher",
      labelKey: "idleResetMinutes",
      summaryKey: "settingsIdleMinutesHint",
      groupKey: "groupSession",
      kind: "number",
      keywords: ["minutes", "timeout", "分钟", "分鐘"],
      value: String(a.idle_reset_minutes),
    }),
    descriptor({
      id: "appearance.recent_count",
      section: "launcher",
      labelKey: "recentCount",
      summaryKey: "settingsRecentCountHint",
      groupKey: "groupSession",
      kind: "number",
      keywords: ["recent", "count", "数量", "最近"],
      value: String(a.recent_count),
    }),
    descriptor({
      id: "appearance.search_placeholder_apps",
      section: "launcher",
      labelKey: "placeholderApps",
      summaryKey: "settingsPlaceholderHint",
      groupKey: "groupSession",
      kind: "text",
      keywords: ["placeholder", "search", "apps", "占位符", "提示"],
      value: a.search_placeholder_apps || t("settingsValueDefault"),
    }),
    descriptor({
      id: "appearance.search_placeholder_clipboard",
      section: "launcher",
      labelKey: "placeholderClipboard",
      summaryKey: "settingsPlaceholderHint",
      groupKey: "groupSession",
      kind: "text",
      keywords: ["placeholder", "clipboard", "占位符", "剪贴板"],
      value: a.search_placeholder_clipboard || t("settingsValueDefault"),
    }),
    descriptor({
      id: "appearance.entry_size",
      section: "launcher",
      labelKey: "settingsEntrySize",
      groupKey: "groupEntryBox",
      kind: "segmented",
      keywords: ["entry", "box", "tile", "条目", "格子"],
      value: `${a.entry_size}px`,
    }),
    descriptor({
      id: "appearance.round_app_icons",
      section: "launcher",
      labelKey: "roundAppIcons",
      summaryKey: "roundAppIconsHint",
      groupKey: "groupEntryBox",
      kind: "switch",
      keywords: ["icon", "circle", "round", "图标", "圆形"],
      value: onOff(a.round_app_icons),
    }),

    descriptor({
      id: "clipboard.history_cap",
      section: "clipboard",
      labelKey: "clipHistoryCap",
      summaryKey: "settingsHistoryCapHint",
      groupKey: "clipGroupHistory",
      kind: "number",
      keywords: ["history", "limit", "cap", "历史", "上限"],
      value: String(c.history_cap),
    }),
    descriptor({
      id: "clipboard.record_images",
      section: "clipboard",
      labelKey: "clipRecordImages",
      summaryKey: "settingsRecordImagesHint",
      groupKey: "clipGroupHistory",
      kind: "switch",
      keywords: ["image", "record", "图片", "記錄"],
      value: onOff(c.record_images),
    }),
    descriptor({
      id: "clipboard.record_files",
      section: "clipboard",
      labelKey: "clipRecordFiles",
      summaryKey: "settingsRecordFilesHint",
      groupKey: "clipGroupHistory",
      kind: "switch",
      keywords: ["file", "record", "文件", "檔案"],
      value: onOff(c.record_files),
    }),
    descriptor({
      id: "clipboard.dedup",
      section: "clipboard",
      labelKey: "clipDedup",
      summaryKey: "clipDedupHint",
      groupKey: "clipGroupHistory",
      kind: "switch",
      keywords: ["duplicate", "dedup", "去重"],
      value: onOff(c.dedup),
    }),
    descriptor({
      id: "clipboard.merge_copy",
      section: "clipboard",
      labelKey: "clipMergeCopy",
      summaryKey: "settingsMergeCopyHint",
      groupKey: "clipGroupMerge",
      kind: "switch",
      keywords: ["merge", "copy", "合并", "合併"],
      value: onOff(c.merge_copy),
    }),
    descriptor({
      id: "clipboard.merge_window_ms",
      section: "clipboard",
      labelKey: "clipMergeWindow",
      summaryKey: "settingsMergeWindowHint",
      groupKey: "clipGroupMerge",
      kind: "number",
      keywords: ["merge", "window", "time", "合并窗口", "時間"],
      value: `${(c.merge_window_ms / 1000).toFixed(1)}s`,
    }),
    descriptor({
      id: "clipboard.ignore_apps",
      section: "clipboard",
      labelKey: "clipIgnoreApps",
      summaryKey: "clipIgnoreHint",
      groupKey: "clipGroupIgnore",
      kind: "editor",
      keywords: ["ignore", "privacy", "app", "忽略", "隐私"],
      value: String(c.ignore_apps?.length ?? 0),
    }),
    descriptor({
      id: "clipboard.show_source_app",
      section: "clipboard",
      labelKey: "clipShowSource",
      groupKey: "groupDisplay",
      kind: "switch",
      keywords: ["source", "app", "来源", "應用"],
      value: onOff(c.show_source_app),
    }),
    descriptor({
      id: "clipboard.time_display",
      section: "clipboard",
      labelKey: "clipTimeDisplay",
      groupKey: "groupDisplay",
      kind: "segmented",
      keywords: ["time", "relative", "absolute", "时间", "時間"],
      value: c.time_display,
    }),
    descriptor({
      id: "clipboard.hover_select",
      section: "clipboard",
      labelKey: "clipHoverSelect",
      summaryKey: "settingsHoverSelectHint",
      groupKey: "groupDisplay",
      kind: "switch",
      keywords: ["hover", "select", "悬停", "選取"],
      value: onOff(c.hover_select),
    }),
    descriptor({
      id: "clipboard.favorites_top",
      section: "clipboard",
      labelKey: "clipFavoritesTop",
      groupKey: "groupDisplay",
      kind: "switch",
      keywords: ["favorite", "pinned", "收藏", "置顶"],
      value: onOff(c.favorites_top),
    }),
    descriptor({
      id: "clipboard.paste_close",
      section: "clipboard",
      labelKey: "clipPasteClose",
      groupKey: "groupPaste",
      kind: "switch",
      keywords: ["paste", "close", "粘贴", "貼上"],
      value: onOff(c.paste_close),
    }),
    descriptor({
      id: "clipboard.preview",
      section: "clipboard",
      labelKey: "settingsClipPreview",
      summaryKey: "settingsClipPreviewHint",
      groupKey: "groupPreview",
      kind: "switch",
      keywords: ["preview", "satellite", "预览", "預覽"],
      value: onOff(c.preview),
    }),
    descriptor({
      id: "clipboard.remember_checks",
      section: "clipboard",
      labelKey: "rememberChecks",
      groupKey: "groupPreview",
      kind: "switch",
      keywords: ["check", "remember", "勾选", "記住"],
      value: onOff(c.remember_checks),
    }),

    descriptor({
      id: "index.system_dirs",
      section: "search",
      labelKey: "settingsSystemIndex",
      summaryKey: "settingsSystemIndexHint",
      groupKey: "settingsSystemIndex",
      kind: "editor",
      keywords: ["desktop", "system32", "start menu", "索引", "目录"],
      value: String(i.system_dirs?.filter((dir) => dir.enabled).length ?? 0),
    }),
    descriptor({
      id: "index.user_index",
      section: "search",
      labelKey: "settingsUserIndex",
      groupKey: "settingsUserIndex",
      kind: "editor",
      keywords: ["folder", "index", "path", "用户索引", "資料夾"],
      value: String(i.user_index?.length ?? 0),
    }),
    descriptor({
      id: "index.cache_refresh_interval_minutes",
      section: "search",
      labelKey: "settingsCacheRefresh",
      summaryKey: "settingsCacheHint",
      groupKey: "groupIndexCache",
      kind: "number",
      keywords: ["cache", "refresh", "interval", "缓存", "刷新"],
      value: `${i.cache_refresh_interval_minutes} ${t("settingsMinutes")}`,
    }),
    descriptor({
      id: "action.refresh_index",
      section: "search",
      labelKey: "settingsRefreshIndex",
      summaryKey: "settingsRefreshIndexHint",
      groupKey: "groupIndexCache",
      kind: "action",
      keywords: ["refresh", "rebuild", "scan", "刷新", "重建"],
      value: t("settingsPageAction"),
    }),

    descriptor({
      id: "hotkeys.toggle",
      section: "hotkeys",
      labelKey: "settingsToggleLauncher",
      summaryKey: "settingsToggleHotkeyHint",
      groupKey: "settingsHotkeys",
      kind: "text",
      keywords: ["hotkey", "shortcut", "toggle", "快捷键", "呼出"],
      value: h.toggle,
    }),
    descriptor({
      id: "hotkeys.switch_mode",
      section: "hotkeys",
      labelKey: "settingsSwitchMode",
      summaryKey: "settingsSwitchHotkeyHint",
      groupKey: "settingsHotkeys",
      kind: "text",
      keywords: ["hotkey", "tab", "mode", "快捷键", "切换"],
      value: h.switch_mode,
    }),

    descriptor({
      id: "automation.enabled",
      section: "automation",
      labelKey: "autoEnabled",
      summaryKey: "autoHint",
      groupKey: "groupAutomation",
      kind: "switch",
      keywords: ["automation", "enable", "自动", "自動"],
      value: onOff(au.enabled),
    }),
    descriptor({
      id: "automation.force_focus",
      section: "automation",
      labelKey: "autoForceFocus",
      summaryKey: "settingsForceFocusSummary",
      groupKey: "groupAutomation",
      detailKeys: ["autoForceFocusHint"],
      kind: "switch",
      keywords: ["focus", "foreground", "焦点", "前景"],
      value: onOff(au.force_focus),
    }),
    descriptor({
      id: "automation.use_agent",
      section: "automation",
      labelKey: "autoUseAgent",
      summaryKey: "settingsUseAgentSummary",
      groupKey: "groupAutomation",
      detailKeys: ["autoUseAgentHint"],
      kind: "switch",
      keywords: ["uipi", "agent", "admin", "提权", "代理"],
      value: onOff(au.use_agent),
    }),
    descriptor({
      id: "automation.agent_resident",
      section: "automation",
      labelKey: "autoAgentResident",
      summaryKey: "settingsResidentSummary",
      groupKey: "groupAutomation",
      detailKeys: ["autoAgentResidentHint"],
      kind: "switch",
      keywords: ["resident", "agent", "常驻", "常駐"],
      value: onOff(au.agent_resident),
    }),
    descriptor({
      id: "automation.actions",
      section: "automation",
      labelKey: "groupAutomation",
      summaryKey: "settingsAutomationRulesHint",
      groupKey: "groupAutomation",
      kind: "editor",
      keywords: ["rules", "actions", "window", "规则", "規則"],
      value: String(au.actions?.length ?? 0),
    }),
    descriptor({
      id: "action.agent_status",
      section: "automation",
      labelKey: "settingsAgentGroup",
      summaryKey: "settingsAgentStatusHint",
      groupKey: "settingsAgentGroup",
      kind: "action",
      keywords: ["agent", "status", "代理", "状态"],
      value: t("settingsOpenSystem"),
    }),

    descriptor({
      id: "action.plugin_install",
      section: "plugins",
      labelKey: "pluginsInstall",
      summaryKey: "settingsPluginInstallHint",
      groupKey: "plugins",
      kind: "action",
      keywords: ["install", "lupx", "安装", "插件"],
      value: t("settingsPageAction"),
    }),
    descriptor({
      id: "plugins.dev_mode",
      section: "plugins",
      labelKey: "pluginsDevMode",
      summaryKey: "pluginsDevModeHint",
      groupKey: "plugins",
      kind: "switch",
      keywords: ["developer", "dev", "开发", "開發"],
      value: onOff((settings.plugins as any)?.dev_mode === true),
    }),
    descriptor({
      id: "plugins.trust_all",
      section: "plugins",
      labelKey: "pluginTrustAll",
      summaryKey: "pluginsTrustAllHint",
      groupKey: "plugins",
      kind: "switch",
      keywords: ["trust", "permission", "授权", "信任"],
      value: onOff((settings.plugins as any)?.trust_all === true),
    }),

    descriptor({
      id: "system.autostart",
      section: "system",
      labelKey: "settingsAutostart",
      summaryKey: "settingsAutostartHint",
      groupKey: "settingsAutostart",
      kind: "action",
      keywords: ["startup", "login", "开机", "開機"],
      value: t("settingsSystemAction"),
    }),
    descriptor({
      id: "system.service",
      section: "system",
      labelKey: "settingsSystemService",
      summaryKey: "settingsServiceHint",
      groupKey: "settingsSystemService",
      kind: "action",
      keywords: ["service", "svc", "index", "服务", "索引"],
      value: t("settingsSystemAction"),
    }),
    descriptor({
      id: "system.agent",
      section: "system",
      labelKey: "settingsAgentGroup",
      summaryKey: "settingsAgentHint",
      groupKey: "settingsAgentGroup",
      kind: "action",
      keywords: ["agent", "uipi", "admin", "代理", "管理员"],
      value: t("settingsSystemAction"),
    }),
    descriptor({
      id: "system.export_settings",
      section: "system",
      labelKey: "settingsExport",
      summaryKey: "settingsExportHint",
      groupKey: "settingsImportExport",
      kind: "action",
      keywords: ["export", "backup", "导出", "匯出"],
      value: t("settingsPageAction"),
    }),
    descriptor({
      id: "system.import_settings",
      section: "system",
      labelKey: "settingsImport",
      summaryKey: "settingsImportHint",
      groupKey: "settingsImportExport",
      kind: "action",
      keywords: ["import", "replace", "导入", "匯入"],
      value: t("settingsPageAction"),
    }),
    descriptor({
      id: "system.restore_backup",
      section: "system",
      labelKey: "settingsRestoreBackup",
      summaryKey: "settingsRestoreBackupHint",
      groupKey: "settingsImportExport",
      kind: "action",
      keywords: ["backup", "restore", "恢复", "備份"],
      value: t("settingsPageAction"),
    }),
    descriptor({
      id: "system.restore_default",
      section: "system",
      labelKey: "settingsRestoreDefault",
      summaryKey: "settingsRestoreDefaultsHint",
      groupKey: "settingsImportExport",
      kind: "action",
      keywords: ["default", "reset", "factory", "默认", "重设"],
      value: t("settingsPageAction"),
    }),

    descriptor({
      id: "about.version",
      section: "about",
      labelKey: "aboutVersion",
      groupKey: "about",
      kind: "text",
      keywords: ["version", "build", "版本"],
      value: "",
    }),
    descriptor({
      id: "about.license",
      section: "about",
      labelKey: "aboutLicense",
      groupKey: "about",
      kind: "text",
      keywords: ["license", "apache", "许可证", "授權"],
      value: "Apache License 2.0",
    }),
    descriptor({
      id: "about.homepage",
      section: "about",
      labelKey: "aboutHomepage",
      groupKey: "about",
      kind: "action",
      keywords: ["github", "homepage", "主页", "首頁"],
      value: "https://github.com/yitao-baka/Lume",
    }),
  ];

  for (const plugin of plugins) {
    entries.push(
      {
        id: `plugin.${plugin.id}`,
        section: "plugins",
        path: `${t(SECTION_LABELS.plugins)} › ${plugin.name || plugin.id}`,
        label: plugin.name || plugin.id,
        summary: plugin.description || undefined,
        details: [],
        kind: "action",
        keywords: [
          plugin.name,
          plugin.id,
          plugin.description,
          ...plugin.keywords,
          "plugin",
          "插件",
        ].filter(Boolean),
        value: plugin.enabled ? t("settingsValueEnabled") : t("settingsValueDisabled"),
      },
    );
    // Use a direct descriptor so dynamic visible labels come from the manifest
    // rather than an i18n key. The shared page still exposes these rows.
    for (const setting of plugin.settings) {
      entries.push({
        id: `plugin.${plugin.id}.setting.${setting.key}`,
        section: "plugins",
        path: `${t(SECTION_LABELS.plugins)} › ${plugin.name || plugin.id} › ${t("pluginSettings")}`,
        label: setting.label || setting.key,
        summary: setting.options.map((option) => option.label || option.value).join(" · ") || undefined,
        details: [],
        keywords: [
          setting.key,
          ...setting.options.flatMap((option) => [option.label, option.value]),
          plugin.name,
          plugin.id,
        ],
        kind:
          setting.type === "toggle"
            ? "switch"
            : setting.type === "select"
              ? "segmented"
              : "text",
        value: setting.default == null ? "" : String(setting.default),
      });
    }
  }
  return entries;
}

/** Rank catalog entries by where the query matched (title, prefix, keyword,
 * summary/details, page name). */
export function searchCatalog(
  entries: SettingDescriptor[],
  rawQuery: string,
): SettingDescriptor[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];
  const scored: { entry: SettingDescriptor; score: number }[] = [];
  for (const entry of entries) {
    const label = entry.label.toLowerCase();
    const path = entry.path.toLowerCase();
    const score = label === query
      ? 0
      : label.startsWith(query)
        ? 1
        : entry.keywords.some((word) => word.toLowerCase().includes(query))
          ? 2
          : (entry.summary ?? "").toLowerCase().includes(query)
            ? 3
            : entry.details.concat([entry.value]).some((text) => text.toLowerCase().includes(query))
              ? 4
              : path.includes(query)
                ? 5
                : label.includes(query)
                  ? 6
                  : -1;
    if (score >= 0) scored.push({ entry, score });
  }
  return scored
    .sort((left, right) => left.score - right.score || left.entry.label.localeCompare(right.entry.label))
    .map((item) => item.entry);
}
