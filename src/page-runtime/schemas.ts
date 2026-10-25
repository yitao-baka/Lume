//! Built-in semantic model schemas and their TypeScript shapes.

import type { JsonValue, ResourceRef } from "./contracts";

export const NAVIGATE_SCHEMA = "lume.navigate/v1" as const;
export const CLIPBOARD_SCHEMA = "lume.clipboard/v1" as const;
export const COLLECTION_SCHEMA = "lume.collection/v1" as const;
export const BUILTIN_PAGE_SCHEMAS = [NAVIGATE_SCHEMA, CLIPBOARD_SCHEMA, COLLECTION_SCHEMA] as const;

export interface NavigateItem {
  id: string;
  label: string;
  description?: string;
  path?: string;
  icon?: ResourceRef;
  source: "app" | "folder" | "feature" | "provider" | "explorer";
  actions: string[];
  pluginId?: string;
  disabled?: boolean;
  mono?: boolean;
  wrap?: boolean;
}

export interface NavigateSection {
  id: string;
  title: string;
  items: NavigateItem[];
  actions: string[];
  expandable: boolean;
  expanded: boolean;
  selectedIndex?: number;
  draggable?: boolean;
  wrap?: boolean;
}

export interface NavigateModel {
  query: string;
  sections: NavigateSection[];
  results?: {
    items: NavigateItem[];
    pluginStart: number;
    total: number;
  };
  selectedSectionId?: string;
  navHidden?: boolean;
  emptyText?: string;
}

export interface CollectionItem {
  id: string;
  label: string;
  description?: string;
  icon?: ResourceRef;
  badges?: string[];
  disabled?: boolean;
  actions: string[];
}

export interface CollectionGroup {
  id: string;
  title?: string;
  expandable?: boolean;
  expanded?: boolean;
  items: CollectionItem[];
}

export interface CollectionModel {
  title?: string;
  groups?: CollectionGroup[];
  items?: CollectionItem[];
  total?: number;
  window?: { offset: number; limit: number };
  emptyText?: string;
}

export interface ClipboardCategory {
  id: string;
  label: string;
  count: number;
}

export interface ClipboardRowModel {
  id: string;
  numericId: number;
  kind: string;
  title: string;
  description?: string;
  icon?: ResourceRef;
  content: string;
  /** `content` is a display preview; the full value stays in the service. */
  contentTruncated?: boolean;
  /** File rows only: total path count and first file's display kind. */
  fileCount?: number;
  fileKind?: string;
  createdAt: number;
  thumb?: ResourceRef;
  pinned: boolean;
  sourceApp?: string;
  timeLabel?: string;
  hasHtml: boolean;
  mergedCount: number;
  valid: boolean;
  checked?: number[] | null;
  disabled?: boolean;
  actions: string[];
}

export interface ClipboardModel {
  query: string;
  categories: ClipboardCategory[];
  activeCategory: string;
  items: ClipboardRowModel[];
  total: number;
  window: { offset: number; limit: number };
  /** Index of the primary row in the full (unwindowed) result list. */
  selectedIndex: number;
  selectedIds: string[];
  primaryId?: string;
  paused: boolean;
  status: { total: number; selected: number; text: string };
  clearState?: { open: boolean; keepPinned: boolean };
  showSourceApp: boolean;
  timeDisplay: "relative" | "absolute";
  hoverSelect: boolean;
  previewEnabled: boolean;
  emptyText?: string;
}

export const navigateFixture: JsonValue = {
  query: "",
  sections: [
    {
      id: "recent",
      title: "Recent",
      actions: ["toggle"],
      expandable: true,
      expanded: false,
      items: [
        {
          id: "app:notepad",
          label: "Notepad",
          path: "C:\\Windows\\notepad.exe",
          source: "app",
          actions: ["open", "open-as-admin", "reveal", "pin"],
        },
      ],
    },
  ],
  results: { items: [], pluginStart: 0, total: 0 },
  navHidden: false,
};

export const clipboardFixture: JsonValue = {
  query: "",
  categories: [{ id: "all", label: "All", count: 2 }],
  activeCategory: "all",
  items: [
    {
      id: "clip:1",
      numericId: 1,
      kind: "text",
      title: "hello",
      pinned: false,
      actions: ["copy", "paste", "pin", "delete", "preview"],
    },
  ],
  total: 2,
  window: { offset: 0, limit: 40 },
  selectedIndex: 0,
  selectedIds: ["clip:1"],
  primaryId: "clip:1",
  paused: false,
  status: { total: 2, selected: 1, text: "1 selected" },
  clearState: { open: false, keepPinned: true },
};

export const collectionFixture: JsonValue = {
  title: "Results",
  groups: [
    {
      id: "main",
      title: "Main",
      expandable: false,
      expanded: true,
      items: [
        {
          id: "row:1",
          label: "Example",
          description: "A collection fixture row",
          actions: ["open"],
        },
      ],
    },
  ],
  total: 1,
  window: { offset: 0, limit: 40 },
  emptyText: "Nothing here",
};
