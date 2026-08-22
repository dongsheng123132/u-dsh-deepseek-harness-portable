# U-DSH Portable 发布路线图

> **这份文件是唯一真相源。** 会话记忆会丢，多终端会打架，所以「下一步干什么」「什么叫做完」
> 只认这里写的。改了先提交，别口头约定。
>
> 最后更新：2026-08-22

## 一句话目标

**一个能放在开源仓库的项目 + 一个下载解压包。**
解压到 U 盘或本地硬盘 → 双击 → 出界面 → 点充值或填 AI 设置 → 能用。
全程不装 Node、不跑 npm、不联网下载内核、不写注册表、不污染 C 盘。

范围：**Windows x64 单平台**。Mac / Linux 明确不在本轮内（见 M2）。

## 验收判据（"做完"的定义，不许放宽）

一个交付只有同时满足下面全部才算完成，缺一条就是没做完：

1. 从 GitHub Release 下载 zip，解压到**从没装过任何 DSH / Node 的干净 Windows x64**（NTFS 盘）。
2. 双击启动器，**不联网也能起到界面**（内核随包，零 npm）。
3. 界面上能走通「充值」和「填自己的 AI 设置」两条路中的至少一条，然后**真的发出一次对话并拿到回复**。
4. 全程没有任何东西写到 `C:` 的用户数据区之外，凭据/会话/工作区都在包所在盘。
5. 拔盘换一台机器插上，接着能用，数据还在。
6. 上面每一条都有**可复现的自检命令或脚本输出**做证据，不是"我看着像好了"。

## 里程碑

### M1 · 内核随包 ✅ 已完成（2026-08-22）

构建时把 Node 运行时 + `@deepseek-ai/dsh` 完整依赖闭包 vendor 进 `resources/`，客户机零 npm。

- `scripts/prepare-vendor.mjs` 生成 `vendor/runtime/win32-x64/` + `vendor/harness/`
- `src/kernel-manager.js` 557 行 → 149 行，安装/下载/系统发现逻辑全删
- 证据：`npm test` 43/43；`smoke:packaged` 在敌意环境（PATH 无 node、
  `npm_config_registry=http://127.0.0.1:1`、虾盘云端点不可达）下 `PACKAGED_SMOKE_OK`
- 代价：zip 139MB → 234.5MB

**这一步同时干掉了**：镜像 ETARGET、`--before` 时间窗、peer 收敛失败、4 分钟超时、
没网就废、以及"复用到一个装坏的全局 DSH"的连锁失败。

### M2 · 防误发 · 进行中

M1 之后包的性质变了，但版本号和门禁没跟上，已经造成一次同名不同物。

- [x] 版本 `0.1.3` → `0.2.0`（架构级变更，不该复用补丁号）
- [x] `docs/releases/v0.1.3.md` 标暂缓；盘上那个被覆写的 234MB 同名包重命名为
      `*.SUPERSEDED`，避免被当成 v0.1.3 分发
- [ ] `dist:mac` / `dist:linux` 加门禁：没有对应平台的 vendor runtime 就直接失败，
      不许打出一个缺内核的壳
- [ ] `docs/releases/v0.2.0.md` 建档，但**顶部标「未发布」**，等 M4 过了才摘

### M3 · 首次运行体验（用户真正要的那条路）

现在只验到"DSH Web UI 起来了"，没验到"人能用起来"。这一段是下载量和好评度的分水岭。

- [ ] 实测走一遍：解压 → 双击 → 首屏 → 充值页 / AI 设置 → 发一句话 → 收到回复。
      每一步截图或记录，卡在哪写在哪
- [ ] 首屏必须自解释：用户不该需要读 README 才知道下一步点什么
- [ ] 「开箱即有额度」是我们对全部竞品的唯一结构性优势（它们全都让用户自己去
      platform.deepseek.com 注册充值），必须在第一屏就体现，不能藏在二级菜单
- [ ] 失败路径要有人话提示：没网、盘是 exFAT、盘满、端口被占

### M4 · 干净机验证（发版硬门槛）

宪法第 4/5 条：别信开发机。`offline-hostile` smoke 是本机最接近的替代品，**不是**裸机。

- [ ] 用 `aliyun-clean-windows-test` 起一台干净 Windows ECS，跑完上面 6 条验收判据
- [ ] 顺带复核一次未复现的 CLI 退出码 7（M1 期间出现一次，此后 3 次未复现，原因未定位）

### M5 · 开源仓库门面

代码能跑 ≠ 能开源发布。

- [ ] **许可合规（硬阻塞）**：`third-party-licenses/` 现在只有 1 个文件
      （`deepseek-harness-LICENSE`），但我们现在随包分发 **255 个顶层包 + 25 个 scope**
      的完整闭包。必须自动生成覆盖整个闭包的许可清单，缺一个都不能发
- [ ] README 关键词重写：现在搜「dsh portable」「便携」都排不进前八，
      而「harness 便携版 U盘」只有我们一个结果——关键词选错了
- [ ] 中文保姆级图文（竞品数据：`deepseek-harness-oneclick-pack` 19★ 但 **4408 次下载**，
      靠的就是这个；技术最扎实的 `sqs404/dsh-portable` 只有 263 次）
- [ ] 下载入口用固定文件名，让 `releases/latest/download/...` 直链跨版本稳定

### M6 · 发版

M1–M5 全绿之后才做。发之前重跑一遍全部验收判据，别信上一轮的绿。

## 不许推翻的既有决定

再讨论一次就是浪费一个会话。要改，先在这里写清为什么。

- **U 盘必须 NTFS，不用 exFAT。** DSH 每次启动要在 `$DSH_HOME/profiles/node_modules` 下建
  junction，exFAT 放不下（实测 exFAT `EISDIR` / NTFS `OK`，同用户同进程）。
  **vendor 闭包修不掉这一条**——那是数据侧不是内核侧。exFAT 唯一好处是 Mac/Linux 兼容，
  而本轮只支持 Windows x64，代价为零。
- **"运行时放本机、只数据放 U 盘"救不了。** 那已经是 v0.1.x 的现状，炸的点就在 data 里面。
- **放真实目录代替符号链接行不通。** 上游 `ensureSymlink` 见到非 symlink 直接 throw。
- **GitHub 上没有现成的"数据随 U 盘走"轮子可抄。** 20 个竞品都只解决"这台电脑免安装"，
  凭据仍落 `%USERPROFILE%\.dsh`。唯一值得抄的是 vendor 闭包那一招（已抄，见 M1）。

## 别再踩的坑

- `missingRequiredPeers` 查的是 node_modules 下**所有顶层包**的 peerDependencies，
  不是根包的（根包声明 0 个）。别"优化"掉。
- npmmirror 上带 `--before` 安装会 `ETARGET`；只把官方 registry 提到第一位**不能**修好。
- PowerShell `Set-Content -Encoding UTF8` 会写 BOM，`JSON.parse` 直接挂。用
  `[System.IO.File]::WriteAllText($f,$txt,(New-Object System.Text.UTF8Encoding $false))`。
- Git Bash 里 `/E` 会被 MSYS 当路径转换，robocopy 参数要用 PowerShell 包一层。
- `Win32_LogicalDisk` 的 FileSystem 字段会给出过期值（把 exFAT 报成 NTFS），用 `Get-Volume`。
- PATH 上的 GNU tar 读不了 zip，用 System32 的 bsdtar。
- electron-builder 的 `extraResources` 会跳过 fileset 根下名为 `node_modules` 的目录，
  必须显式映射 `vendor/harness/node_modules`。
- 本仓库 `remote.origin.fetch` 被窄化成只跟 `main`，所以功能分支永远没有
  `origin/feat/*` 这个 remote-tracking ref，`git status` 不会报 ahead/behind。
  别因此误判成"没推上去"，用 `git ls-remote --heads origin` 核。
- remote-agent 对跑超过约 2 分钟的 exec 会截流，长活要 `Start-Process` 重定向到文件再轮询。
