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

**2026-08-22 本机走查（截图在 `docs/first-run/`）：走到第 6 步失败。**

`06-first-reply.png` 的文件名骗人——图里是 **🔴 本轮运行失败 · `API key is invalid` · AUTH**。
同时 `wallet.status` 返回 `available:false`、无 walletId、无 key。

**根因链（读代码得出，未碰生产）**：

1. `src/main.js:266` 首启**确实**调了 `wallet.ensure()`，而且 `await` 了才起 DSH。
   所以不是「忘了调」。
2. `src/device-wallet.js:180` 的 `doEnsure()` 把**全部失败整个吞掉**：
   ```js
   } catch (error) {
     logger.warn('[device-wallet] 首启收敛失败，DSH 仍继续启动', error?.message)
     return { apiKey: state.apiKey, walletId: state.walletId, configured: false }
   }
   ```
   设计意图是 C1「断网/只读盘/文件锁不能挡住 DSH 启动」，本身合理，
   但**降级是静默的**：用户没有任何提示，一路走到对话框才撞 `API key is invalid`。
3. `logger` 就是 `console`（`device-wallet.js:98`），而打包后的 GUI 没有控制台。
   更糟的是 **`paths.logsDir` 有零个消费者**——`preparePortablePaths` 建了这个目录，
   全仓库没有任何代码往里写。所以这次失败**在磁盘上不留任何痕迹**，
   用户连一份能发给我们的日志都没有。

**结论：「开箱即有额度」这个我们对全部 20 个竞品的唯一结构性优势，当前不成立，
且失败不可观测。** 这是比解压慢严重得多的问题。

**修法（三条都要）**：
- [ ] `configured:false` 必须冒泡到界面：给一句人话 + 一个「重试签发」按钮，
      不能让用户撞进 DSH 内部的 `API key is invalid`
- [ ] 把 `logsDir` 接起来——静默降级至少要在磁盘上留痕，否则远程支持无从下手
- [ ] 首启把「钱包已就绪 / 未就绪」做成第一屏的显式状态，而不是隐含假设

**2026-08-22 实跑确认（用户点名授权后）：签发链路完全正常，整条「开箱即有额度」成立。**

```
wallet.ensure  → available:true  configured:true
wallet.status  → walletId wal_20e7…31fe   balanceAvailable: 1
dsh-home/.credentials.yaml → XIAPAN_CLOUD_API_KEY: sk-129b…
dsh-home/settings.yaml     → provider xiapan-cloud → https://api.u-claw.org/v1
                             agent-default-model: MiniMax-M2.7
```

所以之前那个 `API key is invalid` **不是链路坏了，就是钱包压根没签发过**
（那个环境里 `available:false`）。也就是说 `doEnsure()` 那次静默吞掉的是一次
偶发失败（网络/时序），而我们**当时看不见它**。

这反过来证明修法方向是对的：链路本身没问题，问题是**失败不可观测 + 不告知用户**。
现在 `logsDir` 会记下 `[device-wallet] 首启收敛失败` 的确切原因，
`configured:false` 会主动把钱包页递到用户面前。

- [x] 实测走一遍：解压 → 双击 → 首屏 → 充值页 / AI 设置 → 发一句话 → 收到回复。
      **前 5 步通，第 6 步失败**
- [ ] 修：让首启在用户能发消息之前就完成钱包签发；签发失败要有人话提示而不是让用户
      撞进一个 `API key is invalid`
- [ ] 首屏必须自解释：用户不该需要读 README 才知道下一步点什么
- [ ] 「开箱即有额度」是我们对全部竞品的唯一结构性优势（它们全都让用户自己去
      platform.deepseek.com 注册充值），必须在第一屏就体现，不能藏在二级菜单
- [ ] 失败路径要有人话提示：没网、盘是 exFAT、盘满、端口被占

### M4 · 干净机验证（发版硬门槛）· 内核部分已过

宪法第 4/5 条：别信开发机。`offline-hostile` smoke 是本机最接近的替代品，**不是**裸机。

**2026-08-22 实测**：阿里云 cn-hangzhou，2核4G，Windows Server 2022，
从没装过 node / npm / npx / dsh / git，`.dsh` / `.uking` / `%LOCALAPPDATA%\U-DSH` 全不存在。
测的是 M1 vendored 构建（SHA-256 `43D29984…71054412`）。

| 判据 | 结果 |
|---|---|
| 下载 234.5MB | ✅ SHA-256 与本地逐位一致 |
| 解压 | ⚠️ **1233 秒（20.5 分钟）** —— 见下方「解压时间」 |
| 随包 Node 可执行 | ✅ `v24.19.0`（机器上没有别的 Node，只可能来自包内） |
| `kernel.status`（无界面） | ✅ `ok:true`、`nodeReady:true`、`pinnedVersion 0.1.0-rc.7`，<br>`cacheDir=C:\udsh\resources\harness`（**包内**） |
| 真启动 DSH | ✅ `http://127.0.0.1:50100`，HTTP 200，含 `__DSH_BOOT__` |
| 数据边界 | ✅ `.dsh` / `npm` / `npm-cache` / `.npm` 全 clean；<br>数据只在包内 `data\dsh-home` + `data\u-dsh-state` |

**结论：M1 的核心主张（内核随包、客户机零 npm 零下载）在裸机上证真。**

- [ ] **解压时间是新发现的硬伤**：`Expand-Archive`（= 资源管理器「全部解压缩」）
      在 2 核 ESSD 上跑 20.5 分钟。瓶颈不是字节数，是 525 个包展开出的**几万个小文件**，
      NTFS 逐个建文件的开销。U 盘上只会更慢，而且全程无进度提示。
      竞品 `yuloong07-star/dsh-usb` README 自曝「可能耗时大于 30min」，撞的是同一堵墙。
      **解法候选**：7z SFX 自解压（比 Expand-Archive 快数倍）／首启进度条 ＋
      明确告知「首次解压约 X 分钟，之后秒开」。这条不解决，下载量再高也留不住人。
- [ ] 尚未在干净机上验：钱包签发 → 充值 → 发消息拿回复（见 M3，本机走查已证伪）
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
- [ ] **开源前的密钥体检**（2026-08-22 已跑一次，干净；发版前必须重跑）：
      `git grep -nIE 'sk-[A-Za-z0-9]{16,}|admin[_-]?token|Bearer [A-Za-z0-9]{20,}'`。
      服务端签发逻辑、dealer 私钥、虾盘云 admin token **一律不进这个仓库**——
      商业模式的护城河是服务端，不是客户端代码。
- [ ] `LICENSE` 的版权行现在只有上游 `Copyright (c) 2026 Steven`，
      要补上我们自己的版权行（MIT 允许，但必须保留上游那一行）

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

## ⚠️ 开源前必须在服务端做掉的一件事

**`POST api.u-claw.org/device/bind` 是无鉴权的**（`src/device-wallet.js` 的 `bindFresh`，
body 只有 `hwHint / platform / channel`），调一次就返回一把带余额的 Key。

这不是「机密泄露」——客户端里没有任何密钥，grep 过是干净的——而是**经济暴露**：
谁都能写脚本循环调它白拿额度。这个洞**今天就存在**（解压发布包翻一下就有），
开源只是把「逆向 10 分钟」变成「读代码 10 秒」。

**推公开仓库之前，服务端必须先上限流/风控**（同 IP 频次、设备指纹去重、
邀请码或验证码、新钱包额度下调）。否则「让最多人用」会直接变成「让最多人薅」。
这条不属于本仓库的代码改动，但**它是发版的前置条件**，记在这里防止被忘掉。
