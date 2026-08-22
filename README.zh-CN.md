# U-DSH Portable｜DeepSeek Harness U盘便携版

**U-DSH Portable** 是面向 Windows U 盘的 DeepSeek Harness 便携版：复用官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和社区 [deepseek-harness-desktop](https://github.com/steven-kid/deepseek-harness-desktop)，只增加便携数据边界、版本化内核管理、虾盘云设备钱包和无界面动作接口。

> 当前是 Windows x64 首版。它不是 DeepSeek 官方产品，也不会修改 DSH Web UI 或复制 DSH 的业务实现。

[English](README.md)

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

## 来源与许可

U-DSH 基于 MIT 许可的社区桌面壳，并使用 MIT 许可的官方 DSH；ActionParity 的固定副本按 Apache-2.0 保留许可。完整归因见 [NOTICE.md](NOTICE.md) 和 [third-party-licenses](third-party-licenses)。
