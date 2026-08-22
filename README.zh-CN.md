# U-DSH Portable｜DeepSeek Harness 便携版 · U盘绿色免安装版

> **DeepSeek Harness（DSH）Windows 免安装便携版**：解压即用，**不装 Node.js、不跑 npm、不联网下载内核**。
> 拷进 U 盘或移动硬盘，插到任何一台 Windows 电脑上双击就能用，数据随盘走，不污染 C 盘。

**最大的不同：开箱就有额度，不用自己去申请 API Key。**

其他 DSH 便携版/桌面版都要你先去 platform.deepseek.com 注册账号、充值、复制 Key、粘回软件里 —— 这一段劝退了大多数人。U-DSH 内置**虾盘云设备钱包**：首次启动自动签发一把属于这台设备的 Key 并配好，**打开就能对话**，想加钱点一下「一键充值」。也支持随时换成你自己的 Key。

[English](README.md) · [下载最新版](../../releases/latest) · [常见问题](#常见问题)

## 特性

- ✅ **免安装绿色版**：内置 Node.js 运行时 + `@deepseek-ai/dsh` 完整依赖闭包，客户机零依赖
- ✅ **离线可用**：内核随包，首次启动**不需要联网**（配置模型时才需要网络）
- ✅ **开箱即有额度**：设备钱包自动签发，免注册、免申请 API Key
- ✅ **U 盘便携**：会话、配置、凭据、工作区全在包所在目录，拔盘带走
- ✅ **不污染系统**：不写注册表、不改环境变量、不往 `%USERPROFILE%` 塞东西
- ✅ **无界面可调用**：每个业务动作都有稳定 Action ID，CLI / MCP / API 都能调（ActionParity AP-2）
- ✅ **完全开源（MIT）**：客户端代码可审计、可自建

## 快速开始

1. 到 [Releases](../../releases/latest) 下载 `U-DSH-DeepSeek-Harness-Portable-*-Windows-x64.zip`
2. 解压到 U 盘、移动硬盘或本地文件夹（**U 盘必须是 NTFS 格式**，原因见[常见问题](#常见问题)）
3. 双击 `U-DSH Portable.exe`，等界面出来即可开始对话

> ⏳ **首次解压较慢**：包内是几万个小文件，慢盘上可能要十几分钟。解压完之后启动是秒级的。
> 建议先解压到本地硬盘确认能用，再整个文件夹拷到 U 盘。

## 支持范围

当前是 **Windows x64** 单平台。macOS / Linux 暂不支持（构建会被门禁拦住，不会打出缺内核的坏包）。

它不是 DeepSeek 官方产品，也不修改 DSH Web UI、不复制 DSH 的业务实现 ——
复用官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
与社区 [deepseek-harness-desktop](https://github.com/steven-kid/deepseek-harness-desktop)，
只增加便携数据边界、随包内核、设备钱包和无界面动作接口。

## 为什么采用“瘦壳 + 可换内核”

DSH 仍处于快速更新期。把某个 DSH 版本焊死在 Electron 包里，会让每次升级都重新发布整个桌面应用。U-DSH 把三类状态分开：

| 位置 | 内容 | 是否随 U 盘移动 |
|---|---|---|
| `U-DSH/data/dsh-home/` | DSH 配置、会话、Skills、工作状态 | 是 |
| `U-DSH/data/u-dsh-state/device-wallet.json` | 设备钱包五字段事务状态 | 是 |
| `%LOCALAPPDATA%/U-DSH/` | Electron 缓存、日志、内核激活指针 | 否 |

内核（固定版本的 Node 运行时 + 官方 `@deepseek-ai/dsh` 的完整依赖闭包）在**构建时**由 `npm run prepare:vendor` 整体打进发布包。客户机一行 npm 都不跑、一个字节都不下载：启动只做随包内核的本地解析与校验（包名/版本/入口/必需 peer），毫秒级、完全离线。所有版本参数集中在 [`config/runtime-channel.json`](config/runtime-channel.json)；Node 压缩包的 SHA-256 与 DSH 根包 integrity 都在构建期核对。「检查更新」只报告 npm 标签、绝不安装，网络不通时降级为 unknown、不影响启动。详见 [`docs/vendored-kernel.md`](docs/vendored-kernel.md)。

## 设备钱包

首次联网启动会从虾盘云领取随机 Key，把钱包状态留在 U 盘，并通过唯一配置适配层写入 DSH 的 `.credentials.yaml` 和 `settings.yaml`。钱包窗口支持：

- 查看余额、复制 Key、一键充值；
- 填入已有 Key（先只读验证，成功后才保存）；
- 两阶段换 Key，异常中断后下次启动继续收敛；
- 仅移除本机钱包，不删除服务端余额，随后创建新的空钱包。

虾盘云是新用户的开箱即用默认项，但不是排他通道。官方 DSH 的提供商设置完整保留，用户可以继续添加 DeepSeek 官方 API Key 或其他 OpenAI 兼容服务；如果已经选了其他默认提供商，设备钱包不会把它覆盖掉。

钱包存储损坏、U 盘只读或虾盘云暂时不可达时，不阻断 DSH 自身启动。客户端会被反编译，因此管理密钥和资金权限只应存在于服务端。

## 机器接口（ActionParity）

GUI 和 CLI 共用同一个无界面动作核心。Windows 便携包根目录会生成 `U-DSH-CLI.cmd`：

```powershell
.\U-DSH-CLI.cmd list --json
.\U-DSH-CLI.cmd wallet.status --json
.\U-DSH-CLI.cmd kernel.status --json
.\U-DSH-CLI.cmd kernel.check_updates --json
```

密钥禁止作为命令行参数或普通 JSON 输出；填入 Key 只接受标准输入或文件：

```powershell
'{"apiKey":"sk-..."}' | .\U-DSH-CLI.cmd wallet.key.adopt --input-json - --json
```

换 Key、移除钱包等危险动作需要主进程确认；CLI 使用时需显式传 `--yes`。

## 开发与构建

需要 Node.js 22+：

```powershell
npm install
npm test
npm run action-parity:check-generated
npm run action-parity:verify
npm run shadowfork:contract
npm run prepare:vendor   # 只在构建机跑：把 Node 运行时 + DSH 闭包落进 vendor/
npm run dist:portable    # 有 prepare-vendor --check 门禁：没有闭包就打不出包
```

生成物在 `dist/U-DSH-DeepSeek-Harness-Portable-<版本>-Windows-x64.zip`。需要网络的是构建机上的 vendor 这一步；打包后的应用完全离线可用（设备钱包相关功能除外）。U 盘仍需 NTFS：DSH 每次启动要在 `data/dsh-home/profiles/node_modules` 下建 junction，exFAT/FAT32 不支持。

## 方便继续 fork

项目同时使用影刻协议的两个方向：

- [`.shadowfork/profile.yaml`](.shadowfork/profile.yaml) 记录 U-DSH 相对社区桌面壳上游的定制，后续可判断上游更新是否撞到安全边界；
- [`.shadowfork/upstream.yaml`](.shadowfork/upstream.yaml) 是 U-DSH 给下游 fork 的派生契约，声明必须换的身份字段、保护区、扩展点和归因要求。

业务扩展优先放到 [`src/extensions/`](src/extensions/)，内核版本通过配置升级，ActionParity 生成文件不要手改。

## 常见问题

**U 盘为什么必须是 NTFS？exFAT 行不行？**
不行。DSH 每次启动都要在数据目录下建一个目录链接（junction），exFAT / FAT32 放不下这种链接，
实测直接 `EISDIR` 失败。U-DSH 在启动前会真探一次，盘不对会直接告诉你换 NTFS，而不是抛一堆看不懂的报错。
格式化前记得先备份盘上资料。

**为什么解压这么慢？**
包里是 DSH 的完整依赖闭包，几万个小文件。瓶颈不是体积，是文件数量 —— 慢盘上十几分钟很正常。
这是「客户机零安装、离线可用」的代价：我们在构建时把该装的都装好了，你那边就不用再跑 npm。
解压完之后每次启动都是秒级。

**我不想用你们的额度，能用自己的 Key 吗？**
能。钱包页有「填入已有 Key」，填你自己的就行，随时可以换回来。

**它会往我电脑里写东西吗？**
不写注册表、不改环境变量。会话、配置、凭据、工作区全在包所在目录，删掉文件夹就等于卸载干净。
（Electron 自身的窗口缓存和日志放在系统缓存目录，不含任何凭据。）

**出问题了怎么反馈？日志在哪？**
托盘图标右键 →「报告问题」，或钱包页的「报告问题」按钮。它会自动收好版本、内核状态和
日志摘要（**Key 已打码**），打开预填好的 GitHub issue，你补一句问题描述就能提交。
想自己看日志：`Win + R` 输入 `%LOCALAPPDATA%\U-DSH\logs`。
注意日志放在系统缓存目录，**不跟着 U 盘走**（里面不含任何凭据）。

**这是 DeepSeek 官方的吗？**
不是。这是社区独立发行版，与 DeepSeek 官方无隶属关系。

## 来源与许可

U-DSH 采用 **MIT** 许可，客户端代码可自由使用、修改、商用、再分发。
它基于 MIT 许可的社区桌面壳，并使用 MIT 许可的官方 DSH；ActionParity 的固定副本按 Apache-2.0 保留许可。
发布包内含 libvips（LGPL-3.0-or-later，以可替换的独立 DLL 形式分发）。
完整归因与全部第三方许可原文见 [NOTICE.md](NOTICE.md) 和 [third-party-licenses](third-party-licenses)。

### 商标

MIT 许可覆盖的是**代码**，不包括名称与标识。
**U-DSH**、**U-Claw**、**虾盘云 / Xiapan Cloud** 及相关图标是本项目的品牌标识，不随代码许可一并授予。

欢迎 fork、改造、商用 —— 但请**改用你自己的名称和图标**，不要以 U-DSH / 虾盘云的名义分发，
以免用户把你的构建误认为本项目、把问题反馈到我们这里。虾盘云的额度服务仅面向官方发布的构建。
