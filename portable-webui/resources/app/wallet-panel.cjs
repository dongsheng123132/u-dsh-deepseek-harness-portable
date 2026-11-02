'use strict'
// U-DSH 便携版 · 设备钱包面板（本地页面，纯 node:http，无外部依赖）
//
// 界面按项目技能文档要求做四件事：
//   1. 明说「密钥就是你的钱包，请自行备份」
//   2. 换一把要二次确认，并写明「旧密钥立刻失效、余额不受影响」
//   3. 填入已有 Key 要能粘贴
//   4. 没钱包不拦人：显示「联网后自动获取」
//   5. 移除本机钱包放在危险区，二次确认，明确「不删服务端余额」
//
// 用法：<引导 node> wallet-panel.cjs   （会自动打开浏览器）

const http = require('node:http')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createDeviceWallet } = require('./device-wallet.cjs')

const appRoot = __dirname
const root = path.resolve(appRoot, '..', '..')
const engineRoot = detectEngineRoot()

/** 面板要在内核没跑的时候也能用；引擎目录按版本找最新的那个。 */
function detectEngineRoot() {
  const envRoot = process.env.UDSH_ENGINE_HOST_ROOT?.trim()
  const bases = envRoot
    ? [path.resolve(envRoot)]
    : process.platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'), 'U-DSH', 'engine')]
      : [path.join(require('node:os').homedir(), 'Library', 'Caches', 'U-DSH', 'engine')]
  for (const base of bases) {
    try {
      const versions = require('node:fs').readdirSync(base).filter((v) => !v.includes('.installing') && !v.endsWith('.lock'))
      for (const version of versions.sort().reverse()) {
        const candidate = path.join(base, version)
        if (require('node:fs').existsSync(path.join(candidate, 'node_modules', 'yaml'))) return candidate
      }
    } catch { /* 还没装过引擎 */ }
  }
  return path.join(bases[0] || '', '__engine-not-installed__')
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>设备钱包 · U-DSH</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; background:#f5f7fa; color:#1b2430; font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
  .wrap { max-width:720px; margin:32px auto; padding:0 16px 48px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:#64748b; font-size:13px; margin-bottom:20px; }
  .card { background:#fff; border:1px solid #e3e8ef; border-radius:10px; padding:18px 20px; margin-bottom:14px; }
  .card h2 { font-size:15px; margin:0 0 12px; color:#0f172a; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .key { font-family:ui-monospace,Menlo,Consolas,monospace; background:#f1f5f9; border-radius:6px; padding:6px 10px; }
  .balance { font-size:28px; font-weight:600; color:#0b5cad; }
  .muted { color:#64748b; font-size:13px; }
  button { font:inherit; border-radius:8px; border:1px solid #cbd5e1; background:#fff; padding:8px 14px; cursor:pointer; }
  button:hover { background:#f8fafc; }
  button.primary { background:#0b5cad; border-color:#0b5cad; color:#fff; }
  button.primary:hover { background:#0a4f96; }
  button.danger { border-color:#f0c4c4; color:#b42318; }
  input { font:inherit; padding:8px 10px; border:1px solid #cbd5e1; border-radius:8px; flex:1; min-width:260px; }
  .warn { background:#fff8e6; border:1px solid #f5dfa5; color:#7a5b00; border-radius:8px; padding:10px 12px; font-size:13px; margin-top:12px; }
  .ok { color:#0a7f3f; font-size:13px; }
  .err { color:#b42318; font-size:13px; }
  #log { font-size:13px; margin-top:10px; min-height:18px; }
</style></head>
<body><div class="wrap">
  <h1>设备钱包</h1>
  <div class="sub">这是你的虾盘云钱包：<b>密钥就是钱包</b>，请自行备份（换电脑时用它找回余额）。</div>

  <div class="card">
    <h2>当前钱包</h2>
    <div class="row"><span class="key" id="key">读取中…</span>
      <button onclick="copyKey()">复制密钥</button>
      <button onclick="refresh(true)">刷新余额</button>
    </div>
    <div style="margin-top:14px"><span class="balance" id="balance">—</span>
      <span class="muted" id="balanceHint"></span></div>
    <div class="row" style="margin-top:14px">
      <button class="primary" onclick="recharge()">一键充值</button>
      <span class="muted">充值在浏览器里完成，回来点「刷新余额」即可</span>
    </div>
  </div>

  <div class="card">
    <h2>换一把 / 填入已有</h2>
    <div class="row">
      <button onclick="rotate()">换一把新密钥</button>
      <span class="muted">旧密钥立刻失效，余额不受影响</span>
    </div>
    <div class="row" style="margin-top:12px">
      <input id="adoptInput" placeholder="粘贴一把已有的 sk- 密钥">
      <button onclick="adopt()">启用这把</button>
    </div>
  </div>

  <div class="card">
    <h2 style="color:#b42318">危险区</h2>
    <div class="row">
      <button class="danger" onclick="resetWallet()">移除本机钱包</button>
      <span class="muted">不删除服务端余额；旧余额不会自动进新钱包</span>
    </div>
  </div>

  <div id="log"></div>
</div>
<script>
let state = { apiKey: '', apiKeyMasked: '' };
const $ = (id) => document.getElementById(id);
const say = (text, cls = 'ok') => { const el = $('log'); el.className = cls; el.textContent = text; };

async function api(pathname, body) {
  const res = await fetch(pathname, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}
async function refresh(withBalance = false) {
  try {
    const data = await api('/api/status' + (withBalance ? '?balance=1' : ''));
    state = data;
    $('key').textContent = data.available ? (data.apiKeyMasked || '（已配置）') : '还没领到（联网后自动获取）';
    $('balance').textContent = data.balance && data.balance.available != null ? ('¥' + (data.balance.available / 500000).toFixed(2)) : '—';
    $('balanceHint').textContent = data.balance
      ? (data.balance.error ? ('余额查询失败：' + data.balance.error)
         : ('可用 ' + Number(data.balance.available).toLocaleString() + ' tokens' + (data.balance.available > 0 ? '' : '（还没充值）')))
      : '';
  } catch (error) { say('读取状态失败：' + error.message, 'err'); }
}
async function copyKey() {
  try {
    const data = await api('/api/key');
    await navigator.clipboard.writeText(data.apiKey);
    say('已复制密钥到剪贴板，请妥善保存（它就是你的钱包）');
  } catch (error) { say('复制失败：' + error.message, 'err'); }
}
async function recharge() {
  try { const data = await api('/api/recharge', {}); window.open(data.url, '_blank'); say('已打开充值页；充完回来点「刷新余额」'); }
  catch (error) { say('打不开充值页：' + error.message, 'err'); }
}
async function rotate() {
  if (!confirm('换成新密钥？\\n\\n· 旧密钥会立刻失效\\n· 其它电脑上填过旧密钥的都要改\\n· 余额不受影响（钱记在钱包上）')) return;
  try { const data = await api('/api/rotate', {}); say(data.message + '（' + data.apiKeyMasked + '）'); refresh(); }
  catch (error) { say('换 Key 失败：' + error.message, 'err'); }
}
async function adopt() {
  const apiKey = $('adoptInput').value.trim();
  if (!apiKey) return say('先粘贴一把密钥', 'err');
  try { const data = await api('/api/adopt', { apiKey }); $('adoptInput').value = ''; say(data.message + '（' + data.apiKeyMasked + '）'); refresh(); }
  catch (error) { say('启用失败：' + error.message, 'err'); }
}
async function resetWallet() {
  if (!confirm('移除本机钱包？\\n\\n· 不会删除服务端余额\\n· 旧余额不会进新钱包\\n· 请先确认已备份密钥')) return;
  try { const data = await api('/api/reset', {}); say(data.message); refresh(); }
  catch (error) { say('移除失败：' + error.message, 'err'); }
}
refresh(true);
</script>
</body></html>`

function send(res, code, payload, type = 'application/json; charset=utf-8') {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try { return JSON.parse(text) } catch { return {} }
}

async function main() {
  const wallet = createDeviceWallet({ root, engineRoot })
  // 面板打开时顺带把钱包收敛一次（没网就保持原状，不拦人）
  await wallet.ensure().catch(() => {})

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, PAGE, 'text/html; charset=utf-8')
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        return send(res, 200, await wallet.status({ refreshBalance: url.searchParams.get('balance') === '1' }))
      }
      if (req.method === 'GET' && url.pathname === '/api/key') {
        const status = await wallet.status()
        return send(res, 200, { apiKey: status.apiKey })
      }
      if (req.method === 'POST' && url.pathname === '/api/recharge') {
        return send(res, 200, { url: await wallet.rechargeUrl() })
      }
      if (req.method === 'POST' && url.pathname === '/api/rotate') {
        return send(res, 200, await wallet.rotate())
      }
      if (req.method === 'POST' && url.pathname === '/api/adopt') {
        const body = await readBody(req)
        return send(res, 200, await wallet.adopt(body.apiKey))
      }
      if (req.method === 'POST' && url.pathname === '/api/reset') {
        return send(res, 200, await wallet.resetLocal())
      }
      return send(res, 404, { error: 'not found' })
    } catch (error) {
      return send(res, 400, { error: error?.message || '操作失败' })
    }
  })

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    const url = `http://127.0.0.1:${port}/`
    console.log(`[U-DSH 钱包] 面板已启动：${url}`)
    if (engineRoot.includes('__engine-not-installed__')) {
      console.warn('[U-DSH 钱包] 还没装过引擎：先双击「启动 U-DSH Web」跑一次，钱包才能写进 DSH 配置')
    }
    const opener = process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref()
      : spawn('open', [url], { stdio: 'ignore' })
    void opener
  })
}

main().catch((error) => { console.error(`[U-DSH 钱包] 启动失败：${error.message}`); process.exit(1) })
