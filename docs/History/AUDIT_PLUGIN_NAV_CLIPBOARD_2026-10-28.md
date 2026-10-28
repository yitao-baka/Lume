# 插件系统、导航页与剪贴板页专项审计（2026-10-28）

> 历史审计归档。本报告记录修复前的复现证据与判断，不再定义当前行为；处置记录见
> `docs/ROADMAP_HISTORY.md` #88。

## 范围与基线

- 仓库：LumeLauncher
- 分支：refactor/plugin-system
- 基线提交：ad4a893（2026-10-28）
- 重点范围：插件清单/注册/逻辑宿主/Page Runtime、导航 Provider 与栏目贡献、剪贴板采集/搜索/分类/多选/预览、内置 Presenter 与卫星预览。
- 运行环境：Windows，debug Tauri 构建，WebView2 CDP；测试数据库与临时复现件位于 gitignored 的 test/ 目录。
- 既有审计：docs/History/ 下的三份插件/导航/剪贴板专项报告。本轮重新验证当前代码，不把已修复项重复列为开放缺陷。

## 结论摘要

| 编号 | 严重度 | 结论 | 证据类型 |
| --- | --- | --- | --- |
| F-01 | 高 | 插件剪贴板写入绕过自身 sequence 抑制，文本/图片被记录为用户历史，并错误归属到当前前台应用 | 真实沙箱逻辑帧运行复现 |
| F-02 | 中 | 分类查询先应用 history_cap 再按文件内容类型后过滤；收藏项也受同一 LIMIT 限制，分类结果可能少于数据库中的有效记录 | 代码审阅 + 隔离 SQLite 复现 |
| F-03 | 中 | 分类计数用当前已过滤结果与原始 kind 比较，文本文件/音乐/视频计数恒为 0，图片文件也会漏计；切换分类后“全部”计数随之缩小 | 运行复现 |
| F-04 | 中 | 卫星预览的异步 load 没有请求代际；旧文本/图片/PDF/文件列表读取迟到时可能覆盖新选择 | 代码审阅；运行探针受 Tauri IPC 不可替换限制 |
| F-05 | 中低 | 剪贴板插件读取命令和文件写入命令仍有同步主线程路径，可能被大图片、剪贴板占用或慢磁盘拖住 UI/IPC | 代码审阅 |
| F-06 | 中低 | navBars 文档要求插件内 id 唯一，但预算层接受重复 id；重复栏目共享 section zone 与选择状态 | 隔离 Vite SSR 探针 |
| F-07 | 低 | pin/checked 更新不存在的剪贴板 id 返回成功；clear 返回的计数包含未被删除的收藏记录 | 运行复现 + 代码审阅 |

## F-01 插件写剪贴板被记录成外部历史

### 现象

在真实 host-tools 插件逻辑帧中调用：

~~~js
await window.lume.clipboard.writeText("REAL_PLUGIN_SELF_WRITE_1793176878310");
~~~

随后从主窗口调用 search_clipboard，查询到：

~~~json
[
  {
    "id": 1438,
    "content": "REAL_PLUGIN_SELF_WRITE_1793176878310",
    "source_app": "Chrome"
  }
]
~~~

同一真实逻辑帧用 Canvas 生成 2x2 PNG 后调用 clipboard.writeImage，查询到新增 image 记录：

~~~json
{
  "id": 1439,
  "kind": "image",
  "source_app": "ChatGPT"
}
~~~

capture 监听器轮询 sequence 后把插件写入当成普通用户复制；source_app 取的是当时前台窗口进程，而不是插件身份。重复写入相同文本还会走 dedup，更新原行的 created_at，改变历史排序。

### 根因

- 基建的自身写回保护集中在 src-tauri/src/clipboard.rs 的 write_clipboard_payload（约 166-184 行）：先置 self_write_pending，成功后记录 self_write_seq。
- listener 只在 should_skip_sequence（约 187-192 行）命中时跳过。
- copy_clipboard 与 auto_paste 使用这层保护，但以下插件命令直接调用 arboard 或 set_files_to_clipboard：
  - set_clipboard_text，约 1431-1448 行
  - plugin_clipboard_write_image，约 1717-1748 行
  - plugin_clipboard_write_files，约 1753-1773 行
- 因此插件写入产生的新 sequence 没有被标记为 Lume 自身写入。

### 影响

- 插件生成的文本、图片、文件列表会持久化到用户剪贴板历史，可能导致隐私内容落库。
- source_app 被错误标成 Chrome、ChatGPT 等前台程序，用户无法从历史行判断真实来源。
- 重复写入会触发 dedup 提权，可能把旧行重新排到顶部。
- 写回会消耗 history_cap，可能挤掉用户真实的复制历史；自动合并开启时还可能参与合并。
- 这与“Lume 自己的历史复制/粘贴写回按 sequence 跳过”的当前架构约定不一致。

### 修复建议

1. 把三个插件写命令统一接入 write_clipboard_payload（或抽成可注入 ClipboardState 的安全 helper），保证成功写入后登记 sequence；异步命令将 State 传入 spawn_blocking。
2. 在 host API 层补一条真实逻辑帧回归：writeText、writeImage、writeFiles 都不得新增/重排历史行。
3. 如果产品决定“插件生成的内容应当进入历史”，则必须至少增加显式的 source_app 机制和独立策略；不能沿用前台进程推断，同时要定义 paused、ignore_apps、dedup、merge_copy 的优先级。

## F-02 history_cap 在分类后过滤前截断

### 现象

search_history 对 textfile、music、video、image 的 SQL 先只按 kind 过滤，再按 history_cap 应用 LIMIT，最后在 Rust 中按文件扩展名或图片类型过滤。隔离 SQLite 复现：

- 201 条 file 记录：1 条较旧的 C:/audit/old.txt，200 条较新的 C:/audit/new-*.mkv。
- history_cap = 200。
- SQL 窗口取到 200 条 .mkv，随后 textfile 后过滤得到空列表；数据库中的 old.txt 仍然存在。

另一个边界：

- 1 条较旧 pinned 文本 + 200 条较新普通文本。
- 普通 all 查询的固定 LIMIT 把 pinned 行排除；收藏分类因为 SQL 先加 pinned = 1 仍能查到它。
- 收藏记录按合约不计入历史上限，但“全部”视图和分类统计没有把收藏项排除在 LIMIT 之外。

### 根因

- src-tauri/src/clipboard.rs 的 search_history 约 602-669 行：
  - textfile/music/video 使用 AND kind = 'file'，LIMIT 在进入 Rust 后过滤扩展名之前；
  - image 使用 kind IN ('image','file')，随后再过滤图片扩展名；
  - 所有类别都共享调用方传入的 limit。
- search_clipboard 约 1957-1975 行直接传 clip.history_cap.max(1) 作为 LIMIT。
- 收藏剔除只发生在 prune；查询没有把 pinned 行作为 cap 之外的额外结果处理。

### 影响

- 类别页可能显示空列表或少于实际匹配项，尤其当近期大量文件记录集中在另一内容类型时。
- “全部”视图可能看不到仍在数据库中的旧收藏，但“收藏”分类能看到，两个列表互相矛盾。
- Page Model 的 total、分类计数和窗口 offset 都基于这个不完整结果集，进一步影响选择与虚拟列表。

### 修复建议

- 把内容类型谓词推进到 SQL 的 WHERE：统一文件内容类型函数或预计算 content_kind 列。
- 对收藏采用“pinned 全量 + 普通项按 cap”的查询，或者把 pinned 放在单独的合并结果中，并在模型层明确 total 的语义。
- 增加超过 history_cap 的混合文件、旧收藏、旧文本文件三类回归测试；测试必须断言数据库中存在但查询结果缺失的情况。

## F-03 分类计数与当前筛选结果混用

### 现象

在剪贴板页选择“文本文件”后，模型显示 total = 1、items = 1，但 categories 中：

~~~json
{
  "id": "textfile",
  "label": "文本文件",
  "count": 0
}
~~~

选择“图片”后，全部计数从 200 降为 125，文本计数从 74 降为 0；这并不是历史数据的真实分类计数。

### 根因

src/page-services/clipboard/service.ts 的 snapshot（约 93-111 行）：

- all = store.clips()，此时 store.clips() 已由当前 category 和 query 过滤；
- all 计数直接取 all.length；
- 其它计数使用 item.kind === category.kind；
- 但数据库中的文件记录 kind 是 file，而分类键是 textfile/music/video/image；图片文件也不等于 image kind。

因此：

- textfile/music/video 的文件行永远不会被对应 kind 相等比较计入；
- image 只计 image kind，漏计图片内容文件；
- 当前类别切换后，“全部”和“文本”等计数变成当前过滤集合的重新归类。

### 影响

- 分类徽标与实际列表自相矛盾，用户会看到“0 条”但列表仍有条目；
- 任何依赖 categories 的 Presenter、搜索提示或后续分页都无法得到稳定计数；
- 与 F-02 叠加时，错误计数会进一步掩盖数据截断。

### 修复建议

- 由 Rust 对未筛选历史按同一内容分类规则返回 categories 计数，或在前端对全量历史明确建立独立 categoryCounts；
- 不要从当前类别的 clips() 推导所有类别；
- 让文件类型分类函数成为唯一来源，并为 textfile/music/video/image 的文件行补测试。

## F-04 卫星预览异步读取缺少请求代际

### 代码路径

src/preview.tsx 的 load（约 189-249 行）先 setReq(r)，然后针对 textfile、image、audio/video、filelist、pdf 分别 await invoke；preview-update 监听约 262-264 行使用 void load(payload)。loadPdf 约 167-186 行还有独立的异步 import/getDocument。

代码没有 request generation/token，也没有在 await 后确认 req() 仍是发起请求的 r。多线程时序下可出现：

1. A 选择文本文件，开始读取 A；
2. B 选择文本文件，setReq(B)，B 读取完成并 setText(B)；
3. A 的慢读取完成，无条件 setText(A)；
4. 标题来自 req() = B，正文来自 A。

图片的 setImgSrc、文件列表的 setFilelist、PDF 的 setPdfDoc 具有同类问题。drawPdfPage 的 pdfRenderToken 只保护 canvas 绘制，不保护 loadPdf 结果。

### 证据状态

本轮在真实 debug 实例里尝试对预览页注入延迟；预览页的 window.__TAURI_INTERNALS__.invoke 是 non-configurable，无法在不改源码的情况下替换 IPC 延迟函数，因此没有获得“旧正文覆盖新标题”的运行截图。该风险由代码路径直接导出，属于待补可注入单测的开放竞态，不把它写成机器时序已命中的结论。

### 修复建议

- load 开头递增或捕获 request generation，所有 await 返回后先检查 generation 与 req 是否匹配；
- 为 PDF 单独保存加载 token，旧文档迟到时 destroy，不写入共享 pdfDoc；
- 给 get_file_text、check_file_exists、allow_asset_path 增加延迟测试夹具，断言最终标题和正文都属于最后一次请求。

## F-05 插件剪贴板读写仍有同步主线程命令

### 代码路径

以下命令仍是同步 function command：

- get_clipboard_text，约 1407-1427 行：打开 arboard 并读取文本；
- plugin_clipboard_read_files，约 1779-1794 行：枚举 CF_HDROP；
- plugin_clipboard_has_image，约 1804-1842 行：OpenClipboard、格式枚举；
- plugin_clipboard_read_image，约 1851-1875 行：读取 DIB/自定义 PNG/CF_BITMAP，PNG 编码后再 base64；
- set_clipboard_text，约 1431-1448 行；
- plugin_clipboard_write_files，约 1753-1773 行。

AGENTS.md 的项目约束明确要求：Tauri 同步命令跑在主线程，读文件、解码图片、查大表等重活必须 async / spawn_blocking，否则会卡住所有 IPC（含窗口 set_size），表现为 UI 假死。read_image 的输入路径尤其可能出现 16 MP / 64 MiB 级别的图像与额外 base64 分配；read_files 也会在别的进程持有剪贴板时阻塞 OpenClipboard。

### 影响

- 插件调用 readImage 或剪贴板被其他程序占用时，启动器窗口和所有 Tauri IPC 可能一起停顿；
- 原生剪贴板 API 没有异步取消语义，主线程阻塞会放大为整个启动器无响应。

### 修复建议

- get_clipboard_text、read_files、has_image、read_image、set_clipboard_text、write_files 全部改为 async command，并把 arboard、OpenClipboard、格式化、PNG 编码与 base64 放进 spawn_blocking；
- 对 has_image 的热路径做短超时或缓存 probe，不要在每次空查询中无限等待剪贴板锁；
- 补一个持锁进程夹具，断言 UI IPC 仍能在剪贴板读取期间响应。

## F-06 navBars 重复 id 没有被拒绝

### 现象

PLUGIN_API 5.7 明确规定 navBars 的 id 必须插件内唯一，宿主以插件 id + 栏目 id 作为 zone key。但 src/plugins/contributionBudget.ts 的 sanitizeNavBarContributions 只检查：

- id 非空；
- id 长度不超过上限；
- title/items 形状。

不检查同一插件返回的重复 id。隔离 Vite SSR 探针输入两个 id 都是 same 的栏目，得到：

~~~json
{
  "accepted": 2,
  "dropped": 0,
  "ids": ["probe:same", "probe:same"]
}
~~~

下游 src/plugins/navigate/store.ts：

- 两个 NavSection 直接使用同一个 b.id；
- selected、expanded 状态都按 b.id 存取；
- sectionById 使用 sections().find，zone 也只是一个字符串。

因此两个栏目会共享展开/选择状态，键盘导航或右键动作只能稳定命中第一个同 id 栏目。

### 修复建议

- sanitizeNavBarContributions 为每个插件维护 Set，重复 id 丢弃后续项并记录 diagnostic；
- fitNavBarPageBudget 再做一次跨插件/整页唯一性检查，作为防御纵深；
- 添加重复 id fixture，断言只保留第一栏且 UI 的 selected/expanded 为独立对象。

## F-07 剪贴板变更命令的失败语义不一致

### 现象

- pin_clipboard 对不存在的 id 调用成功并返回 null；
- set_clipboard_checked 对不存在的 id 也返回成功；
- clear_clipboard(keep_pinned=true) 返回的 count 是清理前的 COUNT(*)，不是真正删除的行数。

运行探针：

~~~js
await invoke("pin_clipboard", { id: 999999, pinned: true });
await invoke("set_clipboard_checked", { id: 999999, checked: [] });
~~~

两项都没有报错。代码中 SQL UPDATE 没有检查 changes()。

### 根因

- src-tauri/src/clipboard.rs 的 set_clipboard_checked（约 2597-2609 行）直接执行 UPDATE；
- pin_clipboard（约 2614-2617 行）调用 set_pinned，后者也只返回 execute 的 Ok；
- clear_clipboard（约 2622-2631 行）先 SELECT COUNT(*) 再调用 clear_history。

### 影响

- 删除、清空、预览勾选与 pin 操作并发时，过期 target id 可以被静默接受；
- 前端可能显示一次“成功”的乐观操作，实际行已不存在；
- 外部调用方无法区分成功更新与 no-op，后续统计或撤销逻辑会漂移。

### 修复建议

- 对 UPDATE 检查 conn.changes() == 1，否则返回明确的 not_found 错误；
- clear_history 返回实际删除数，或由 clear_clipboard 在清理前后计算差值；
- 为不存在 id、并发删除、收藏保留三种情况补单元测试和 toast 断言。

## 已排除的候选与测试盲区

- 剪贴板条目 1379 的 .ini 路径不在图片分类中属于预期行为；它是文本文件，不是图片内容文件。不能据此判定图片分类漏项。
- 在真实运行中，分类切换后模型 total 会变化是当前设计；F-03 只追究 categories 计数与 item.kind 的语义不一致，不把“分类结果数量变化”本身当成缺陷。
- 预览探针首次出现 null request，是因为启动器失焦/隐藏导致 show_preview 的空操作；重新呼出后请求路径正常，该环境噪声不计入缺陷。
- 并行运行两条 CDP 验证时出现一次端口冲突；单独串行重跑后专项脚本通过，该现象属于测试编排限制，不作为产品失败。

## 验证记录

- pnpm exec tsc --noEmit：通过
- pnpm run build：通过，128 modules
- cargo check：通过
- cargo test：270 passed / 9 ignored
- cargo clippy --all-targets --message-format=short：0 warning
- pnpm run test:page-runtime：18/18
- pnpm run test:clipboard-model：10/10
- pnpm run test:clipboard-store：7/7
- pnpm run test:plugin-contract：PASS api=2
- pnpm run test:skin-system：11/11
- node scripts/check_i18n.mjs：587 keys × 3 languages
- node scripts/cdp_page_runtime_verify.mjs：PASS
- node scripts/cdp_plugin_nav_clipboard_fix_verify.mjs：PASS
- node scripts/cdp_audit_r2_verify.mjs：15/15
- pnpm run tauri build --debug --no-bundle：通过

## 复现附件（test/ scratch，不入库）

- test/audit_real_plugin_write_probe.mjs：真实 host-tools 逻辑帧写剪贴板并查询历史。
- test/audit_category_after_limit.py：以搜索 SQL 的同一顺序构造混合文件历史，展示后过滤后结果为空。
- test/audit_nav_duplicate_probe.mjs：直接调用 navBars 预算函数，展示重复 id 未被丢弃。
- test/preview-race-a.txt / preview-race-b.txt：预览并发加载的候选夹具。
- test/audit-cdp-race.log、test/audit-preview-race.log：本轮 CDP 诊断输出。

## 建议的处理顺序

1. 先修 F-01 和 F-05：两者分别影响隐私/历史完整性与主线程可用性，且都集中在 clipboard.rs，可合并为一次“剪贴板宿主边界”改动。
2. 再修 F-02/F-03：先统一后端分类谓词和计数，再让前端只消费后端结果。
3. 补 F-04 的请求代际和可注入时序测试，避免慢 IPC 重现预览串台。
4. 最后处理 F-06/F-07：它们属于插件贡献和 mutation API 的防御性边界，适合连同契约测试一起收口。
