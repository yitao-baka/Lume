# 文档归档

本目录存放不再作为现行契约维护的报告、审计与被取代方案。归档保留原始证据、判断和验证记录，但不定义当前行为；现状以 `docs/` 根目录的现行契约、源码与 `CHANGELOG.md` 为准。

## 归档规则

- 报告、审计或方案不再承担现行约束时归档，不继续在活跃文档区维护副本。
- 仍有开放发现时，先转入 `docs/ROADMAP.md` 或现行契约，不随报告一起归档。
- 归档时同步更新所有入链、图片路径和相关代码注释，并在下方索引登记。
- `CHANGELOG.md` 与 `docs/ROADMAP_HISTORY.md` 保留原始上下文，路径指向归档后的位置。

## 索引

| 文档 | 内容 | 后续依据 |
| --- | --- | --- |
| [BUG_REPORT_2.md](BUG_REPORT_2.md) | 子进程 PATH 丢失机器级段 | `docs/ROADMAP_HISTORY.md` #51 |
| [BUG_REPORT_3.md](BUG_REPORT_3.md) | 启动器 UI 独立缺陷审查 | `docs/ROADMAP_HISTORY.md` #52 |
| [BUG_REPORT_4.md](BUG_REPORT_4.md) | 启动器交互逻辑专项审计 | `docs/ROADMAP_HISTORY.md` #53 |
| [UI_VISUAL_AUDIT_2026-10-17.md](UI_VISUAL_AUDIT_2026-10-17.md) | 视觉与可用性审查 | `docs/ROADMAP_HISTORY.md` #54 |
| [UX_SETTINGS_AUDIT_2026-10-18.md](UX_SETTINGS_AUDIT_2026-10-18.md) | 设置窗口体验审计 | `docs/ROADMAP_HISTORY.md` #56 |
| [SETTINGS_AUDIT_2026-10-20.md](SETTINGS_AUDIT_2026-10-20.md) | 设置面板审查与截图证据 | `docs/ROADMAP_HISTORY.md` #62 |
| [UX_TEXT_AUDIT_2026-10-22.md](UX_TEXT_AUDIT_2026-10-22.md) | 用户可见文案语义审查 | `docs/ROADMAP_HISTORY.md` #69 |
| [REFACTOR_AUDIT_2026-10-24.md](REFACTOR_AUDIT_2026-10-24.md) | Page Runtime 重构审计 | `docs/ROADMAP_HISTORY.md` #79 |
| [AUDIT_PLUGIN_NAV_CLIPBOARD_2026-10-25.md](AUDIT_PLUGIN_NAV_CLIPBOARD_2026-10-25.md) | 插件系统、导航页与剪贴板专项审计 | `docs/ROADMAP_HISTORY.md` #85 |
| [PAGE_MODEL_PRESENTER.md](PAGE_MODEL_PRESENTER.md) | Page Service / Presenter 重构设计 | `PLUGIN_API.md`、`ARCHITECTURE.md` |
| [SETTINGS_ACCENT_COLOR.md](SETTINGS_ACCENT_COLOR.md) | 设置窗主题色与调色盘历史设计 | `SETTINGS.md`、`SKIN_SYSTEM.md` |
| [SETTINGS_REDESIGN.md](SETTINGS_REDESIGN.md) | Quiet Control Deck 历史设计 | `SETTINGS.md`、`UI_GUIDELINES.md` |
| [SETTINGS_REDESIGN_SELECTED.md](SETTINGS_REDESIGN_SELECTED.md) | Chromatic Edge 历史设计 | `SETTINGS.md`、`UI_GUIDELINES.md` |
| [SETTINGS_SKIN_SWITCH.md](SETTINGS_SKIN_SWITCH.md) | 设置窗双皮肤切换历史契约 | `SKIN_SYSTEM.md`、`SETTINGS.md` |

`assets/settings-audit-2026-10-20/` 保存设置面板审查引用的截图。
