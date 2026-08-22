# 随包内核（vendored kernel）设计说明

> 适用版本：`feat/u-dsh-portable-wallet` 分支起。本文讲清构建期/运行期的分界、
> 为什么这么做，以及 NTFS 为什么依然必需。

## 要根治的问题

v0.1.3 及以前，客户机首启时 `kernel-manager` 会在客户机上真跑
`npm install @deepseek-ai/dsh@<pinned>`。这条路在干净机器上是断的：

- 镜像 ETARGET、`--before` 时间窗与镜像元数据不同步；
- peer 依赖多轮收敛在慢网/坏代理下反复不收敛；
- 4 分钟超时一到直接失败；没网就彻底废；
- 还会"复用"到本机一个装坏的全局 DSH，连锁失败。

同样的 npm 命令在开发机上手工跑是能成的——问题从来不在命令，在客户机的网络与环境。
所以答案不是把安装逻辑修得更健壮，而是**把安装这件事从客户机上整个拿走**。

## 分界：构建期干所有脏活，运行期只做解析

### 构建期（开发机，需要网络）：`npm run prepare:vendor`

`scripts/prepare-vendor.mjs` 产出两个目录（都是构建产物，进 `.gitignore` 不进仓库）：

| 目录 | 内容 | 关键校验 |
|------|------|----------|
| `vendor/runtime/win32-x64/` | Node 运行时（版本/URL/SHA-256 来自 `config/runtime-channel.json`） | **SHA-256 必须匹配**；删 `include/`（只在编译原生模块时有用） |
| `vendor/harness/` | DSH 依赖闭包：`package.json` + `node_modules/`，`node_modules/@deepseek-ai/dsh` 是根包 | 包身份/版本、`bin.dsh` 入口不越界、根包 integrity 与官方 registry 元数据一致、peer 全收敛 |

闭包的装法沿用原来 `installDsh()` 在开发机上已调通的那套：
`--legacy-peer-deps`、`--before=<发布时间+10min>`（防 prerelease caret 漂到 rc.8）、
镜像→官方 registry 逐个回退、以及**多轮 peer 收敛循环**（查的是 node_modules 下
所有顶层包的 peerDependencies，DSH 内部包靠 peer 互相发现，根包声明 0 个）。
去掉了 `--prefer-offline`（怀疑是客户机装坏的诱因之一，构建机上也没必要）。

装完的后处理（借鉴 salathleizhang/deepseek-harness-desktop 的 `prepare-runtime.mjs`）：

1. `materializeStagedLinks`：所有 symlink/junction 换成解引用真实拷贝；`.bin` 整个删掉（子进程直接用随包 node 跑入口，不走 shim）；
2. `pruneHarness`：`node-pty/prebuilds/` 只留 `win32-x64`；
3. 施加 `dsh-host-apiproxy` 的 Windows 打开路径补丁（见下）；
4. 原子落地：先装在 `vendor/.harness-staging-<pid>/`，全部校验通过才 rename 到 `vendor/harness/`，失败清干净不留半成品。

打包时 `electron-builder` 的 `extraResources` 把它们落到发布包的
`resources/runtime/`、`resources/harness/`。`dist:portable` / `dist:win` 链里
插了 `prepare-vendor.mjs --check`（离线门禁）：vendor 缺失或与
`runtime-channel.json` 版本不符就打不出包——绝不允许打出一个没有闭包的壳。

### 运行期（客户机，零网络、零安装）

`src/kernel-manager.js` 只做"解析已随包的内核"：

- `nodeExecutable` = `<resources>/runtime/win32-x64/node.exe`
- DSH 入口 = `<resources>/harness/node_modules/@deepseek-ai/dsh` 按其 `bin.dsh` 解析
- 开发态（未打包）回落到仓库的 `vendor/`，`npm start` 照常可用
- `ensure()` 是纯本地校验（身份/版本/入口/peer，能抓到拷贝损坏或用户手删），毫秒级
- `checkLatest()` 只报告 npm 上有没有新版，**非致命**：网络不通返回 `latest: ''`（unknown），绝不影响启动

删掉的东西（连同只服务它们的辅助函数）：`installDsh`、`discoverSystemDsh`、
`discoverSystemNode`、`download`、`expandZipWindows`、系统 Node/DSH 回落、
`portable-paths` 里的 `downloadsDir` / `nodeVersionsDir` / `dshVersionsDir` /
`npmCacheDir`。回归防线：`test/kernel-manager.test.js` 断言内核代码路径里
不存在 `child_process` / `spawn` / npm 相关字符串，且 `ensure()` 在 fetch
被换成必然抛错的桩时依然成功。

决定性证据在 `npm run smoke:packaged`：解压出的包在「PATH 里没有 node、
`npm_config_registry` 指向不可路由地址、虾盘云端点不可达」的敌意环境下，
CLI 依然应答、DSH 服务照常起来并给出 Web URL。

## dsh-host-apiproxy 的 -EncodedCommand 补丁为什么保留

上游 `@deepseek-ai/dsh-host-apiproxy@0.1.0-rc.7` 的 `openWindowsPath` 仍是
`powershell.exe -Command "Invoke-Item -LiteralPath '<path>'"`（2026-08 从官方
tarball 复核）。命令字符串走 argv 明文，在中文 Windows / 含引号等特殊字符的
U 盘路径上会被 PowerShell 参数重组阶段二次解释。补丁改为 UTF-16LE Base64 的
`-EncodedCommand`，命令原样送达。原来这个补丁写在死代码
`prepare-dependencies.mjs` 里、指向不存在的路径；现在移到
`scripts/patch-harness-apiproxy.mjs`，构建期由 `prepare-vendor.mjs` 施加到
vendor 出来的闭包上（此时 apiproxy 真实存在）。上游实现一旦漂移，补丁会
fail loudly，逼人复核而不是静默漏打。

## 数据边界与 NTFS：vendor 修不掉的部分

- **数据边界不变**：`DSH_HOME` 依然是 `<portableRoot>/data/dsh-home`，凭据、
  会话、工作区全部跟 U 盘走，不漏到 `C:`。宿主机只留 Electron 缓存、日志和
  内核激活指针（`<LOCALAPPDATA>/U-DSH/kernel/active.json`）。
- **U 盘仍然必须 NTFS**。vendor 只解决了"内核怎么来"；DSH 每次启动还要在
  `$DSH_HOME/profiles/node_modules` 下建 junction，那在数据侧（U 盘上），
  exFAT/FAT32 不支持 junction，这个问题 vendor 修不掉。

## 体积账

| 项 | 大小（2026-08-22 实测） |
|----|------|
| v0.1.3 发布包（运行时下载内核） | 139MB（zip） |
| vendor 后 Node 运行时 | 101.2MB（已删 `include/`） |
| vendor 后 DSH 闭包 | 208.2MB（剪枝前 219.7MB） |
| vendor 后发布包 | 234.5MB（zip），解压后约 455MB |

换来的是：客户机首启从「几分钟 npm 安装 + 一堆网络失败模式」变成「毫秒级本地校验」，
且没网也能用（设备钱包相关功能除外）。
