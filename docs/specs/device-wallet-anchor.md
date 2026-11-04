# 设备钱包锚点规范（u 系列统一）

> 适用：u-dsh / u-claw · U-ClawX / u-openclaw / 虾盘 AI 精灵（u-picoclaw）/ 以后新开的线。

## 一句话

**钱包钉在「盘」上，不钉在「目录」上。** 客户插同一支 U 盘，不管换机器、换目录、重装、换版本，看到的都是同一个钱包。

## 为什么（真实事故）

2026-11-03 在客户机上实测：一台电脑攒出 **4 个钱包**，客户充的 ¥1 落在第 3 个里，
新装的壳子版又领了第 4 个 → 用户看到"充了钱没到账"。根因是钱包路径 = `<当前数据目录>/u-dsh-state/`，
而数据目录跟着"解压在哪/装在哪"变。

## 解析顺序（实现见 `portable-webui/resources/app/wallet-locate.cjs`）

| # | 位置 | 说明 |
|---|---|---|
| 1 | `env UDSH_WALLET_FILE` | 逃生门，运维覆盖 |
| 2 | `<dataDir>/u-dsh-state/device-wallet.json` | 老版本/老布局，兼容 |
| 3 | **`<盘>/.xiapan/device-wallet.json`** | **统一锚点（新建就写这里）** |
| 4 | `<盘>/.u-dsh/device-wallet.json` | 历史位置 |
| 5 | `<盘>/data/u-dsh-state/…`、`<盘>/u-dsh/data/u-dsh-state/…` | 常见目录 |
| 6 | 同盘浅扫一层：`<盘>/<任意目录>/data/u-dsh-state/…` | 客户改成任意文件夹名也能找到 |
| 7 | **外接盘**：Windows `D:`–`Z:`、macOS `/Volumes/*` 上的 `.xiapan/device-wallet.json` | **装在本机的版本也能用回 U 盘的钱包** |
| 8 | 宿主指针 `%LOCALAPPDATA%\U-DSH\last-wallet.txt` | 只存路径，不存凭证 |

- 命中即**沿用**，日志写明来源（`沿用已有钱包文件（来源：external-volume:F:\）`）。
- 全都没命中才新建，且**写进统一锚点** `<盘>/.xiapan/`，下次任何产品/任何目录都能找到。
- 系统盘（macOS `/`、无盘符）不建锚点，退回 data 目录，避免在 `/` 上乱写。

## 各产品要做的

1. 钱包写入路径**必须**经过统一解析函数，禁止各产品自己拼 `data/u-dsh-state/…`。
2. `.xiapan/device-wallet.json` 是**跨产品共享锚点**：u-dsh、U-ClawX、精灵谁先创建都一样。
3. 安装器/桌面版（数据在 C 盘）**必须**保留"外接盘扫描"，否则客户插回自己的 U 盘看不到钱。
4. 新建钱包时在日志里打一行 `来源：new-anchor`，便于远程排查"钱去哪了"。
5. 钱包文件里只放 `apiKey / walletId / pendingKey / pendingKind / pendingFrom`（五字段），
   宿主机不留凭证；宿主侧只留"路径指针"。

## 验收

- [ ] 同一支盘上，把便携包改名/换目录 → 仍是同一个 `walletId`
- [ ] 装在本机的版本 + 插上有锚点的 U 盘 → 自动用盘上钱包（日志显示 `external-volume:`）
- [ ] 全新盘 → 新建在 `<盘>/.xiapan/`，且第二次启动 source 变成 `volume-anchor`
- [ ] 系统盘无 U 盘时不往 `/` 或根目录写东西

## 业界怎么做的（对照，2026-11 调研）

| 做法 | 代表 | 终端用户要不要 API Key | 账户体系 | 我们的取舍 |
|---|---|---|---|---|
| 平台账户额度 | OpenRouter、各类中转站 | 要（每用户一把 key） | 必须注册登录 | ❌ 不做账号：注册是最大流失点 |
| 订阅制 | Cursor / Claude Code / Windsurf | 不要（本地登录态 token） | 必须登录+订阅 | ❌ 月付门槛高，且要维护登录态 |
| 应用内嵌额度 | [llmgateway embeddable credits](https://github.com/theopenco/llmgateway/blob/b1ad08cc486bedbea3ea007038e86794ca7c7c3c/apps/ui/src/content/blog/2026-06-07-embeddable-ai-credits.md) | 不要（应用方持有上游 key，用户充应用内余额） | 应用自有账号 | ✅ 最接近我们：用户只见"余额" |
| **设备钱包（我们）** | U-DSH / U-ClawX / 精灵 | **不要**：钱包 key 自动写进内核配置 | **没有账号体系** | ✅ 插盘即用、充值即用 |

我们比"应用内嵌额度"再省一层：**连应用账号都没有**，钱包凭证就是身份（等同预付费公交卡）。
代价是"丢盘不可找回"——所以规则必须是**凭证钉在盘上**（本文档），而不是钉在某个目录/某台机器上；
盘才是那张卡，目录只是插槽。

## 一句产品口径

> 插上盘就是你的账号；充值进这张卡；换电脑、换目录、重装都还是同一张卡。
