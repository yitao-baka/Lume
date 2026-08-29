//! Context-menu construction — builds the item list for the custom right-click
//! menu from the app / folder / clipboard menu states. Pure: takes the two
//! stores and returns plain { label, icon, action } rows for the view.

import { t } from "../i18n";
import administratorRunIcon from "../../res/icons/administrator_run.svg";
import clipboardIcon from "../../res/icons/clipboard.svg";
import deleteIcon from "../../res/icons/delete.svg";
import folderOpenIcon from "../../res/icons/folder_open.svg";
import pinIcon from "../../res/icons/pin.svg";
import pinnedIcon from "../../res/icons/pinned.svg";
import runIcon from "../../res/icons/normal_run.svg";
import { isUrl } from "./clipData";
import type { MenuState } from "./types";
import type { NavigateStore } from "./navigate";

/** The clipboard-side actions the shared context menu needs — provided by
 * the clipboard plugin's store (structurally satisfied). */
export interface ClipMenuActions {
  copyOnly(item: { valid?: boolean; id: number }): void;
  pasteClip(item: { valid?: boolean; id: number }): void;
  toggleClipPin(item: { pinned: boolean; id: number }): Promise<void> | void;
  copyPlain(item: { valid?: boolean; id: number; kind: string; has_html: boolean }): void;
  openClipLink(item: { content: string; kind: string }): void;
  revealClipFile(path: string): void;
  requestDelete(id: number): void;
}

export interface MenuDeps {
  nav: NavigateStore;
  clip: ClipMenuActions;
}

export interface MenuItem {
  label: string;
  icon: string;
  action: () => void;
}

/** Menu entries for the open context menu. */
export function buildMenuItems(deps: MenuDeps, m: MenuState): MenuItem[] {
  const { nav, clip } = deps;
  if (!m) return [];
  if (m.kind === "app") {
    const isPinned = nav.pinnedApps().some((p) => p.path === m.app.path);
    const items = [
      {
        label: isPinned ? t("unpin") : t("pin"),
        icon: isPinned ? pinnedIcon : pinIcon,
        action: () => void nav.toggleAppPin(m.app),
      },
      { label: t("launch"), icon: runIcon, action: () => nav.launchApp(m.app) },
      {
        label: t("openFileLocation"),
        icon: folderOpenIcon,
        action: () => nav.revealInFolder(m.app),
      },
    ];
    // The 「最近使用」 bar inserts a soft-delete (remove-from-recent) just
    // before the admin action.
    if (m.fromRecent) {
      items.push({
        label: t("removeFromRecent"),
        icon: deleteIcon,
        action: () => void nav.deleteRecent(m.app),
      });
    }
    items.push({
      label: t("launchAsAdmin"),
      icon: administratorRunIcon,
      action: () => nav.launchApp(m.app, true),
    });
    return items;
  }
  if (m.kind === "folder") {
    // The copy-path tile has no elevation; the two terminal tiles launch
    // normally or as administrator.
    if (m.idx >= 2) {
      return [
        { label: t("copyPath"), icon: clipboardIcon, action: () => nav.activateFolder(2, false) },
      ];
    }
    return [
      { label: t("launch"), icon: runIcon, action: () => nav.activateFolder(m.idx, false) },
      {
        label: t("launchAsAdmin"),
        icon: administratorRunIcon,
        action: () => nav.activateFolder(m.idx, true),
      },
    ];
  }
  const isPinned = m.item.pinned;
  const items = [
    { label: t("copyBack"), icon: clipboardIcon, action: () => clip.copyOnly(m.item) },
    { label: t("pasteBack"), icon: clipboardIcon, action: () => clip.pasteClip(m.item) },
    {
      label: isPinned ? t("unpin") : t("pin"),
      icon: isPinned ? pinnedIcon : pinIcon,
      action: () => void clip.toggleClipPin(m.item),
    },
  ];
  // Rich-text rows offer a plain-text copy that strips the formatting.
  if (m.item.kind === "text" && m.item.has_html) {
    items.push({
      label: t("copyPlainText"),
      icon: clipboardIcon,
      action: () => clip.copyPlain(m.item),
    });
  }
  // Link rows open in the browser; file rows reveal in Explorer.
  if (m.item.kind === "text" && isUrl(m.item.content)) {
    items.push({
      label: t("openLink"),
      icon: runIcon,
      action: () => clip.openClipLink(m.item),
    });
  }
  if (m.item.kind === "file") {
    const first = m.item.content.split("\n").find(Boolean);
    if (first) {
      items.push({
        label: t("openFileLocation"),
        icon: folderOpenIcon,
        action: () => clip.revealClipFile(first),
      });
    }
  }
  items.push({
    label: t("delete"),
    icon: deleteIcon,
    action: () => clip.requestDelete(m.item.id),
  });
  return items;
}
