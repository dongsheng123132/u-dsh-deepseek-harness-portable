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
| `%LOCALAPPDATA%/U-DSH/` | Electron 缓存、Node、各版本 DSH、npm 缓存、日志 | 否 |

第一次在一台电脑上运行时，U-DSH 下载并校验固定版本的 Node，再把固定版本的官方 DSH 安装到本机缓存（依网络和磁盘情况可能需要几分钟）。以后启动直接复用；U 盘只承担需要带走的数据，避免持续高频读写。所有版本参数集中在 [`config/runtime-channel.json`](config/runtime-channel.json)。国内镜像用于下载加速，但根包完整性仍与官方 npm 元数据核对。

内核安装采用临时目录、包名/版本/入口/必需 peer 依赖校验、超时与镜像回退、原子改名和激活指针。新版本启动失败时仍可回到已安装的旧版本；“检查更新”只报告 npm 标签，不会未经验证自动替换正在使用的内核。

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
npm run dist:portable
```

生成物在 `dist/U-DSH-DeepSeek-Harness-Portable-<版本>-Windows-x64.zip`。首次启动需要网络，Node 下载包会先做 SHA-256 校验。

## 方便继续 fork

项目同时使用影刻协议的两个方向：

- [`.shadowfork/profile.yaml`](.shadowfork/profile.yaml) 记录 U-DSH 相对社区桌面壳上游的定制，后续可判断上游更新是否撞到安全边界；
- [`.shadowfork/upstream.yaml`](.shadowfork/upstream.yaml) 是 U-DSH 给下游 fork 的派生契约，声明必须换的身份字段、保护区、扩展点和归因要求。

业务扩展优先放到 [`src/extensions/`](src/extensions/)，内核版本通过配置升级，ActionParity 生成文件不要手改。

## 来源与许可

U-DSH 基于 MIT 许可的社区桌面壳，并使用 MIT 许可的官方 DSH；ActionParity 的固定副本按 Apache-2.0 保留许可。完整归因见 [NOTICE.md](NOTICE.md) 和 [third-party-licenses](third-party-licenses)。
