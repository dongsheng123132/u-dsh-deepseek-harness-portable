/**
 * 首次运行体验的纯逻辑：钱包入口注入、udsh:// 拦截、要不要主动递上钱包页。
 * 与 Electron 解耦，方便 node --test 直接断言。
 */

// 主窗口里点「钱包」走 window.open(WALLET_OPEN_URL)，由主进程拦截成打开钱包窗口。
export const WALLET_OPEN_URL = 'udsh://wallet'

export function isWalletOpenRequest(url) {
  return typeof url === 'string' && url.trim().toLowerCase().startsWith('udsh:')
}

/**
 * 主窗口起来后要不要直接把钱包页递到用户面前：
 * - 还没有钱包（离线首启）：用户需要知道「联网重试」在哪
 * - 有未完成的换 Key 操作：需要用户看一眼
 * - 余额为 0：新钱包的默认状态，不递上去用户发一句话只会得到一个报错
 * 已充值（余额 > 0）或余额未知（离线未查询）时不打扰。
 */
export function shouldAutoOpenWallet(status) {
  if (!status) return true
  if (!status.available) return true
  if (status.pending) return true
  return status.balanceAvailable !== null
    && status.balanceAvailable !== undefined
    && status.balanceAvailable <= 0
}

/**
 * 注入到 DSH Web UI 的悬浮钱包入口。
 * 「开箱即有额度」是相对全部竞品的唯一结构性优势，不能只藏在系统托盘里；
 * 这里在主界面右上角放一个常驻入口，点了走 udsh://wallet 回主进程。
 * 幂等：重复注入不会出现第二个按钮。
 */
export function buildWalletEntryScript({ locale = 'zh-CN' } = {}) {
  const zh = String(locale).toLowerCase().startsWith('zh')
  const label = zh ? '💳 钱包 / 充值' : '💳 Wallet / Top up'
  const title = zh
    ? '设备钱包：查看余额、一键充值、备份或填入 Key'
    : 'Device wallet: balance, top up, back up or restore your key'
  return `(() => {
    if (document.getElementById('udsh-wallet-entry')) return
    const button = document.createElement('button')
    button.id = 'udsh-wallet-entry'
    button.setAttribute('data-udsh-entry', 'wallet')
    button.type = 'button'
    button.textContent = ${JSON.stringify(label)}
    button.title = ${JSON.stringify(title)}
    button.style.cssText = 'position:fixed;top:10px;right:14px;z-index:2147483647;' +
      'padding:6px 14px;border-radius:999px;border:1px solid rgba(110,168,254,.5);' +
      'background:rgba(37,99,235,.92);color:#fff;font:600 13px system-ui,sans-serif;' +
      'cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)'
    button.addEventListener('click', () => { window.open(${JSON.stringify(WALLET_OPEN_URL)}) })
    document.body.appendChild(button)
  })()`
}
