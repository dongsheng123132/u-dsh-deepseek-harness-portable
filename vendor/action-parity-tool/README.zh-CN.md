<p align="center"><img src="docs/readme-assets/action-core-hero.webp" alt="影核：GUI、CLI、MCP、API 和自动化调用同一个动作核心" width="100%" /></p>

# 影核（ActionParity）

> **一个动作，所有界面。**

> **版本边界：工具链 `v0.7.0`，Manifest 规范 `0.5.0`。** 两者独立演进，
> AI 可用 `action-parity --version --json` 同时读取，详见
> [版本规则](docs/VERSIONING.md)。

影核是一套面向 AI 时代的软件开放标准，英文名 **ActionParity**，亦称 **ShadowCore 协议**：让同一个应用同时成为“人类原生”和“Agent 原生”的应用。

一个产品只有一个权威的动作核心，所有平台界面都是它的原生影子——这就是“影核”两个字的意思。命名规则见 [docs/NAMING.md](docs/NAMING.md)。

每个有业务意义的动作，只在无界面的 **Action Core（动作核心）** 中实现一次，再由 GUI、CLI、TUI、MCP、API、自动化测试等不同入口共同调用。

```text
人类 ── GUI / TUI ───────┐
                         ├── Action Core ── 状态 / 事件 / 权限
Agent ─ CLI / MCP / API ─┘
                                │
                         一致性验证与报告
```

GUI 不是软件本身，CLI 也不是软件本身。它们是同一套动作和状态模型的不同投影。

## 两个问题，答案只有能与不能

软件现在由 AI 和人一起写、一起用。这两件事难在同一个地方：**行为长在界面里**。于是多一个界面就要把行为再写一遍，而操作软件就等于操作像素。

**一、能不能只写一遍？**

> 开发者——人或 AI——把一个行为**实现一次**，GUI、CLI、MCP、API、测试的入口都由这一份实现派生出来，而不是每个界面各写一遍。

同一个能力写三遍还要保持一致，是「既给人用又给 Agent 用」的软件最大的成本。AI 辅助开发只会让它更糟不会更好：**生成三份实现很容易，发现三份已经跑偏很难。**

**二、能不能不看像素就操作？**

> 一个没读过源码的 Agent，能**发现**这个软件能做什么、知道每个行为的输入输出、副作用和风险，**调用**它，并**断言**结果——不用截图、不用视觉模型、不用模拟点击。

截图驱动适合验证「人看到的对不对」，不适合当业务调用的地基。一个只提供界面的软件，等于逼着所有 Agent 走这条路。

**这两个问题里都没有百分比。**

至于测试怎么分层——业务对不对直接测动作核心，人能不能看懂用 UI 自动化和无障碍树——那是上面第二个问题成立之后自然得到的结果，不是目的本身。

## 最核心的规则

> 每个有业务意义的用户动作，都必须有唯一、稳定的 Action ID，并且无论从哪个界面触发，都必须调用同一个规范实现。

这不等于“每一个按钮必须有一条 CLI 命令”。

以下内容通常属于业务动作：

- 创建、修改、删除；
- 导入、导出、同步；
- 启动、停止、重启；
- 检测、诊断、修复；
- 配置、验证、发布、升级；
- 购买、发送、授权等外部副作用。

以下内容通常属于界面动作：

- 切换标签页；
- 展开侧栏；
- 鼠标悬停；
- 拖动窗口；
- 播放动画；
- 调整纯视觉布局。

界面动作由 UI 自动化测试；业务动作必须进入 Action Core。

## AI 从 Registry 开始，不从 Manifest 开始

在可运行的 Rust 参考实现中，Manifest 已是生成物。一个尚未接入的仓库先做零配置只读盘点：

```text
action-parity doctor . --json
```

接入后，AI 编程工具再执行：

```text
action-parity context . --json
```

根目录的 `action-parity.config.json` 会告诉它 Registry 真相源、禁止手改的生成文件、准确的生成命令和最终验证命令。统一的 [ActionParity 开发 Skill](skills/action-parity/SKILL.md) 把这张项目地图变成 Codex、Claude Code、Hermes 共用的开发流程，不要求 AI 先读完整规范。

Tauri/TypeScript 项目加上 `action-parity generate ... --typescript`，还会从同一 Registry 生成 Action 常量、输入输出类型、类型安全调用 client 和单命令 Tauri 桥。前端业务代码不再复制 Rust 中的 Action ID 字符串。

已有运行时 Registry 不必先改写成 `action-parity-core`。只要它能导出有效的 0.5 Manifest，就可以只生成并检查 TypeScript client，不接管项目已有的 CLI/MCP：

```text
action-parity generate action-parity.json --out-dir src/generated --typescript
action-parity generate action-parity.json --out-dir src/generated --typescript --check
```

第二条命令只读；生成文件缺失或被手改时以非零退出码失败。

实现入口：[Rust Registry 样例](examples/rust-registry)、[Agent Profile Schema](schema/action-parity.agent-profile.schema.json)、[Agent 原生开发路线](docs/AGENT-NATIVE-DEVELOPMENT.zh-CN.md)。

## SDK

两个运行时 SDK 实现同一个动作核心、同一个执行信封、同一份 `action-parity.registry-bundle/v1`，因此同一套工具链既能生成也能验证它们：

| SDK | 包名 | 自带的机器入口 |
| --- | --- | --- |
| Rust | [`action-parity-core`](crates/action-parity-core) | Tauri 适配器、通用 dispatch |
| Node / Electron / TypeScript | [`action-parity-sdk`](sdk/node) | 自动生成的 CLI、MCP stdio 服务、Electron IPC 桥、HTTP 入口 |

```js
import { createRegistry, defineAction, defineSurface, s } from "action-parity-sdk";
import { createCliRunner } from "action-parity-sdk/cli";
import { serveMcpStdio } from "action-parity-sdk/mcp";
import { attachElectronIpc } from "action-parity-sdk/electron";
```

注册一个 Action，CLI 就多一条带参数、带帮助、带退出码的命令，AI 就多一个 MCP 工具，GUI 就多一条带稳定 `data-action-id` 的目录项，生成的 Manifest 就多出对应 Binding。传输层不含任何业务实现；确认、权限、陈旧状态拒绝、幂等重试、超时都在核心里强制，不在各界面各写一遍。

详见 [Node SDK 说明](docs/NODE-SDK.md) 与 [Node Registry 样例](examples/node-registry)——它的 16 条 Binding 由 GUI、CLI、MCP、HTTP 四个真实传输的可执行证据验证通过。

## 一句话架构

过去容易写成：

```text
点击按钮
  └── 在按钮事件里直接改文件、调用网络、启动进程
```

影核要求写成：

```text
GUI 按钮 ─┐
CLI 命令 ─┼── action.execute("gateway.start", input)
MCP 工具 ─┘
                  │
             唯一业务实现
                  │
          统一结果、状态、事件和审计
```

GUI 不需要每次启动 CLI 子进程。GUI、CLI 和 MCP 可以直接引用同一个库，也可以通过本地 IPC 调用同一个常驻 Action Runtime。

## 影子里不许有什么

符合与不符合是二元的，就落在四条规则上。一个界面——核的**影子**——不许有：

1. **第二份业务实现**；
2. **只存在于它自己这里的策略判断**——一个破坏性动作如果唯一的闸门是前端弹窗，那么第二个影子一出现它就是**零防护**的，而第二个影子正是这套标准存在的理由；
3. **独立的状态真相源**——影子可以缓存，不可以拥有；
4. **只能从它到达的动作**——GUI 有、别处没有的功能，就是 Agent 用不上的功能。

呈现、输入收集、平台集成，这些**才是影子该干的事**。业务行为不是。

验证器输出违规和位置，不打分：

```text
Shadow desktop   gui/in-process     6 action(s)   6 proven   checked
Shadow cli       cli/external       6 action(s)   6 proven   checked
Shadow mcp       mcp/local-ipc      6 action(s)   6 proven   checked

Violations   0
Unproven     0
```

一个应用如果唯一的非可视入口是它自己的 webview 命令桥（`#[tauri::command]`、`ipcRenderer` 之类），那它拥有的是私有调用约定，不是机器入口——违反第 4 条。[`examples/gui-only`](examples/gui-only/action-parity.json) 留作这个回归用例。

**等级是可选的。** AP-1~AP-4 和那套覆盖率百分比是一份**审计规程**，不是标准本身，见 [docs/AUDIT-PROFILE.md](docs/AUDIT-PROFILE.md)（含它为什么被移出正文）。**一个实现可以完全符合影核架构，而从不产出任何分数。**

## 为什么还需要真实 GUI 测试

CLI 或 MCP 测通，只能证明业务逻辑正确，不能证明：

- GUI 按钮绑定到了正确动作；
- 输入框可填写；
- 错误提示可见；
- 深色模式和高 DPI 正常；
- 窗口没有遮挡；
- 键盘焦点顺序合理；
- 屏幕阅读器和自动化工具可以理解控件。

因此影核不是要淘汰 Computer Use，而是让它回到正确位置：

> Action Core 是主测试层；UI Automation 是界面验证层；视觉 Computer Use 是最终兜底层。

## 与现有规范的关系

我们不重新发明已有协议：

- MCP 负责 Agent 工具发现和调用；
- OpenAPI / OpenRPC 负责机器可读接口描述；
- WebDriver、Appium、Windows UI Automation 负责操作真实界面；
- ANIP 关注 Agent 调用的权限、风险和可逆性；
- AgentReady 关注 Web 产品能否被 Agent 端到端使用；
- AG-UI、ggui 关注 Agent 与前端界面的通信和生成；
- Tauri Commands、Blender Operators、Apple App Intents 是很好的实现机制。

影核要补的空位是：

> **规定一个真实应用的 GUI、CLI、MCP、自动化入口必须共享同一个业务动作核心，并且能通过机器验证证明没有漂移。**

完整对比见 [docs/LANDSCAPE.md](docs/LANDSCAPE.md)。

## 三个真实项目试点

当前基准不再假设 U-King 是 Electron 样例，而是直接测量三个真实仓库：

1. Redline：9 个稳定 Action 已共享 Rust 核心；完整实接后前端手写 Action ID 从 9 降为 0，1,670 行协议产物全部生成；
2. 照做：5 个外部 GUI 兼容 Action，用于测量无法改造的旧软件；
3. U-King：完整试点已从现有 Rust 核心生成 46 个宿主 Action 的 0.5 Manifest 与 288 行严格 TypeScript client；CLI 46/46、可核对 GUI 21/46、stale 0，迁移两个真实 GUI 调用后跨 Rust/前端手写 ID 风险从 21 降到 19。Linux 干净检出 CI 会重新导出并阻止漂移，公开实现见 [U-King PR #315](https://github.com/dongsheng123132/u-king-mini/pull/315)。

详细数据与开发优先级见 [三个真实项目基准](docs/REAL-PROJECT-BASELINE.zh-CN.md)，历史计划见 [docs/U-KING-PILOT.md](docs/U-KING-PILOT.md)。

## 试点回馈

真实应用改造中发现的规范问题会写成案例回馈，作为 v1.0 的输入：

- [docs/CASE-CC-SWITCH.zh-CN.md](docs/CASE-CC-SWITCH.zh-CN.md) —— cc-switch / uu-switch（Tauri + React，270 个命令、零机器入口）。
  暴露的核心问题：**一个零机器入口的纯 GUI 应用，不写一行代码就能通过校验**——`ipc` 与 `test` 缺少可达性要求。
  更要紧的是，它让「分数在度量架构形状而不是机器可用性」这件事显形，直接促成了 0.5.0 把重心搬回一核多影。
- [docs/PROPOSAL-CORE-FIRST.zh-CN.md](docs/PROPOSAL-CORE-FIRST.zh-CN.md) —— 把重心搬回架构、计分降级为可选审计（已采纳）。

## 开源与商业价值

规范、Schema、验证器和参考适配器保持开放。商业价值可以来自：

- 企业迁移与架构改造；
- 影核 CI 和可视化报告；
- 独立认证与兼容性实验室；
- Electron、Tauri、.NET、Swift 等商业支持；
- Agent 权限、审计与策略控制台；
- 测试设备云和干净 Windows/macOS 环境；
- 行业测试包、培训和认证课程。

标准必须保持中立：自测永远免费，认证规则公开，商业客户不能购买标准条款。详见 [docs/BUSINESS.md](docs/BUSINESS.md)。

## 当前状态

**工具链 v0.7.0；Manifest 规范 0.5.0。** 当前已经具备两个可运行的 Action Registry（Rust 与 Node/Electron）、Manifest/CLI/MCP/TypeScript 确定性生成、可直接跑的 CLI/MCP/IPC/HTTP 传输层、可执行 Binding 证据，以及供 AI 编程工具发现项目的 Agent Profile 与统一 Skill。可安装的 npm tarball 已通过 [GitHub Releases](https://github.com/dongsheng123132/action-parity/releases) 提供；`action-parity`、`action-parity-sdk` 与两个 crate 都尚未发布到公共 registry，因此暂时不能把这些坐标写成“已可用”。准确渠道状态见[发布闸门](docs/RELEASING.md)。

目前阶段的目标不是宣称标准已经完成，而是：

1. 把新增 Action 的协议胶水压到业务实现之外不超过 20 行；
2. 用 Redline、照做与 U-King/Tauri 做真实改造；
3. 让 Codex、Claude Code、Hermes 在不阅读完整 SPEC 的情况下完成同一任务；
4. 发布可复现的生成、验证和采用实验；
5. 在真实实现基础上推进 v1.0。

规范正文：[SPEC.md](SPEC.md)  
推广路线：[docs/ADOPTION.md](docs/ADOPTION.md)  
项目宣言：[MANIFESTO.md](MANIFESTO.md)  
首发手册：[docs/LAUNCH.md](docs/LAUNCH.md)  
发布闸门：[docs/RELEASING.md](docs/RELEASING.md)<br>
参与方式：[CONTRIBUTING.md](CONTRIBUTING.md)

## 许可证

Apache License 2.0，见 [LICENSE](LICENSE)。
