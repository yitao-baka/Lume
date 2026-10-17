从 Lume 启动的进程，PATH 丢失机器级（系统）段
环境
Lume 2.8.0（D:\Program\Lume\lume.exe）
Windows 11 专业版，build 26200
首次复现：2026-10-16
现象
从 Lume 里启动 VS Code，集成终端与构建任务全部失败：

'chcp' 不是内部或外部命令，也不是可运行的程序或批处理文件。
终端进程启动失败(退出代码: -1)
凡是位于 C:\Windows\System32 的命令（chcp、where、robocopy…）都找不到。用户侧表现为「编译器/工具链突然坏了」，极难联想到启动器。

最小复现
确认 HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment 的 Path 含 C:\Windows\system32（默认值就有）
从 Lume 里启动 cmd.exe
执行 echo %PATH% → 只有用户级那串，没有 C:\Windows\system32
对照：从资源管理器启动 cmd.exe，同样 echo %PATH% → 机器段 + 用户段俱全
不需要 VS Code，用 cmd.exe 就能复现。

实测数据
来源    PATH 长度    含 C:\Windows\system32
HKLM 机器级（注册表原文，含未展开的 %SystemRoot%）    381    ✅
HKCU 用户级    438    ❌
资源管理器启动的进程    810    ✅
Lume 启动的进程    438    ❌
Lume 启动的进程，其 PATH 与 HKCU\Environment\Path 逐字符完全相等（438 == 438）。也就是说，机器段不是「被截断」，而是根本没被拼上去。

根因
Windows 对 PATH 有特殊规则：进程的 PATH = 机器级 PATH + ; + 用户级 PATH（两段拼接）。

Lume 的做法看起来是「把 HKCU\Environment 下的键逐个覆盖到子进程环境上」。对绝大多数变量这是对的，但 PATH 恰好是 Windows 唯一需要拼接而不是覆盖的变量 —— 这一步把整个机器段抹掉了。

旁证：

HKCU\Environment 下 10 个变量（Path/TEMP/TMP/OneDrive/CARGO_HOME/RUSTUP_HOME/FLUTTER_STORAGE_BASE_URL/PUB_HOSTED_URL/ANDROID_HOME/LUME_GITHUB_TOKEN）在子进程里全部存在 → 确认是「用户级环境整体覆盖上去」这一套做法。
除 PATH 外，SystemRoot / windir / ComSpec / PATHEXT 都正常 → 不是环境块损坏，就是 PATH 这一项被覆盖。
时间线：21:48 往用户级 PATH 里新增了一项，21:51 从 Lume 启动的进程里立刻就能看到这一项 → Lume 在 21:48 之后重新读过 HKCU\Environment（启动子进程时现读，或收到 WM_SETTINGCHANGE 后自刷新），但读的只有 HKCU，没有 HKLM。
影响范围
不止 VS Code。 任何从 Lume 启动、且依赖机器级 PATH 的程序都会中招：编译器、git、各种 CLI 工具，以及内部会去调 System32 命令的 GUI 程序。因为症状（「某某命令找不到」）和启动器毫无关联，用户排查成本极高。

建议修复
构造子进程环境时，PATH 要按 Windows 规则拼接，而不是覆盖：

PATH = (HKLM 机器级 Path) + ";" + (HKCU 用户级 Path)
机器级从 HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment 的 Path 读（注意该值是 REG_EXPAND_SZ，需要展开 %SystemRoot% 之类的引用）。其它变量维持现在的覆盖行为即可，那是符合预期的。

若不方便对 PATH 特判，另一个更省事的做法是干脆不传自定义环境块 —— CreateProcess 的 lpEnvironment 传 NULL，让子进程直接继承 Lume 自身环境（前提是 Lume 自己的环境是完整的，见下）。

一点说明（证据边界）
本报告能证明的是：Lume 的子进程 PATH 残缺。至于 Lume 自身进程的 PATH 是否也残缺（即它是被另一个坏环境启动的），本次未取得直接证据 —— 建议修复后顺带自查一下 Lume 自己进程的 PATH 是否完整。
