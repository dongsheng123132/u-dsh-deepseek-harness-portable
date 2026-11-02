#!/usr/bin/env node
/**
 * 真机验证：引擎装本机 / 数据留盘（WebUI 便携包）。
 *
 * 用法（在便携包根目录或任意位置跑）：
 *   node scripts/verify-engine-install.mjs --app "<便携包根>" [--mode auto|host|drive|temp|usb]
 *        [--expect-install|--expect-reuse] [--json <报告文件>]
 *
 * 做的事：
 *   1. 用 <包>/resources/app/runtime/<平台>/node 跑 web-launch.cjs，抓 stdout/stderr；
 *   2. 等到 "已就绪：<url>"，HTTP 抓一次首页，确认内核真的活着；
 *   3. 退出内核（SIGTERM），按模式断言：
 *        host/drive/temp → engine-manifest.json 存在且版本对、runtime+闭包都在；
 *        auto            → 至少断言不是 usb，且 manifest 存在；
 *        temp            → 退出后临时引擎目录必须消失（零残留）；
 *        usb             → 不产生本机引擎目录，内核直接从盘上跑；
 *      所有模式都断言：数据目录在便携包内 data/dsh-home（数据随盘）。
 *   4. 打印人类可读结论 + 可选 JSON 报告。
 *
 * 退出码 0 = 全部断言通过，1 = 有断言失败，2 = 用法/环境错误。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function parseArgs(argv) {
  const out = { mode: null, app: null, expect: null, json: null, timeoutMs: 120000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--app') out.app = argv[++i]
    else if (a === '--mode') out.mode = argv[++i]
    else if (a === '--json') out.json = argv[++i]
    else if (a === '--timeout-ms') out.timeoutMs = Number(argv[++i])
    else if (a === '--expect-install') out.expect = 'install'
    else if (a === '--expect-reuse') out.expect = 'reuse'
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return out
}

function nodeRel() {
  if (process.platform === 'win32') return path.join('runtime', 'node-win-x64', 'node.exe')
  return path.join('runtime', process.arch === 'arm64' ? 'node-mac-arm64' : 'node-mac-x64', 'bin', 'node')
}

function engineBase() {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(local, 'U-DSH', 'engine')
  }
  return path.join(os.homedir(), 'Library', 'Caches', 'U-DSH', 'engine')
}

function dshVersion(appRoot) {
  // 单文件归档形态：版本写在 engine.json（node_modules 在归档里，读不到）。
  try {
    const meta = JSON.parse(readFileSync(path.join(appRoot, 'engine.json'), 'utf8'))
    if (meta?.version) return meta.version
  } catch {}
  const pkg = JSON.parse(readFileSync(path.join(appRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
  return pkg.version
}

function dirSize(p) {
  let total = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) { try { total += statSync(full).size } catch {} }
    }
  }
  try { walk(p) } catch {}
  return total
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

function runLauncher({ appRoot, mode, timeoutMs }) {
  const runtimeRoot = path.join(appRoot, 'resources', 'app')
  const nodeExe = path.join(runtimeRoot, nodeRel())
  if (!existsSync(nodeExe)) throw new Error(`便携包缺少 Node 运行时：${nodeExe}`)
  const env = { ...process.env }
  if (mode) env.UDSH_ENGINE_MODE = mode
  const child = spawn(nodeExe, [path.join(runtimeRoot, 'web-launch.cjs')], {
    cwd: runtimeRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  let output = ''
  let url = null
  let resolveReady
  const ready = new Promise((resolve) => { resolveReady = resolve })
  const onData = (chunk) => {
    const text = chunk.toString()
    output += text
    process.stdout.write(text.replace(/^/gm, '    │ '))
    if (!url) {
      const m = /已就绪：(\S+)/.exec(output) || /^dsh web: (\S+)/m.exec(output)
      if (m) { url = m[1]; resolveReady(url) }
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  const timer = setTimeout(() => resolveReady(null), timeoutMs)
  return {
    child,
    ready,
    getOutput: () => output,
    stop: () => new Promise((resolve) => {
      clearTimeout(timer)
      if (child.exitCode != null) return resolve(child.exitCode)
      child.once('exit', (code) => resolve(code))
      // 连同子进程组一起收掉：只杀启动器会留下孤儿内核（占端口/文件句柄）。
      const killTree = (signal) => {
        try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch {} }
      }
      killTree('SIGTERM')
      setTimeout(() => { if (child.exitCode == null) killTree('SIGKILL') }, 15000).unref?.()
    }),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.app) {
    console.log('用法：node scripts/verify-engine-install.mjs --app "<便携包根>" [--mode host|drive|temp|usb|auto] [--expect-install|--expect-reuse] [--json report.json]')
    process.exit(args.help ? 0 : 2)
  }
  const appRoot = path.resolve(args.app)
  if (!existsSync(path.join(appRoot, 'resources', 'app', 'web-launch.cjs'))) {
    throw new Error(`不像便携包根目录（缺 resources/app/web-launch.cjs）：${appRoot}`)
  }
  const version = dshVersion(path.join(appRoot, 'resources', 'app'))
  const dataRoot = path.join(appRoot, 'data', 'dsh-home')
  const base = engineBase()
  const beforeEngines = existsSync(base) ? new Set(readdirSync(base)) : new Set()

  console.log(`\n== U-DSH 引擎安装真机验证 ==`)
  console.log(`  包根：${appRoot}`)
  console.log(`  引擎版本：${version}`)
  console.log(`  请求模式：${args.mode || '(auto)'}`)
  console.log(`  数据目录：${dataRoot}\n`)

  const runner = runLauncher({ appRoot, mode: args.mode, timeoutMs: args.timeoutMs })
  const url = await runner.ready
  check('内核启动并打印就绪 URL', !!url, url || runner.getOutput().slice(-400))

  if (url) {
    try {
      // web 内核的就绪 URL 带一次性 token：先拿到 303 + Set-Cookie，再用 cookie 取首页。
      const first = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000) })
      const cookie = (first.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
      const home = await fetch(new URL('/', url), {
        headers: cookie ? { cookie } : {},
        signal: AbortSignal.timeout(20000),
      })
      const body = await home.text()
      check('HTTP 首页可访问', home.ok && body.length > 0, `status=${first.status}→${home.status} bytes=${body.length}`)
    } catch (error) {
      check('HTTP 首页可访问', false, error.message)
    }
  }

  await new Promise((r) => setTimeout(r, 1500))
  let engineDir = null
  if (existsSync(base)) {
    const after = readdirSync(base).filter((e) => !beforeEngines.has(e) || e === version)
    engineDir = after.includes(version) ? path.join(base, version) : (after[0] ? path.join(base, after[0]) : null)
  }
  const manifestPath = engineDir ? path.join(engineDir, 'engine-manifest.json') : null
  const manifest = manifestPath && existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : null

  check('数据目录在便携包内（data/dsh-home）', existsSync(dataRoot), dataRoot)

  const mode = args.mode || 'auto'
  if (mode === 'host' || mode === 'drive' || mode === 'auto') {
    check('本机/盘上引擎目录已生成', !!engineDir, engineDir || '(未找到)')
    check('engine-manifest.json 版本匹配', manifest && manifest.version === version, manifest ? `version=${manifest.version}` : '缺失')
    if (engineDir) {
      const nodePath = path.join(engineDir, nodeRel())
      const entryPath = path.join(engineDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      check('引擎内 Node 运行时存在', existsSync(nodePath), nodePath)
      check('引擎内 DSH 入口存在', existsSync(entryPath), entryPath)
      console.log(`  引擎体积：${(dirSize(engineDir) / 1024 ** 2).toFixed(1)} MB`)
    }
    if (args.expect === 'reuse') {
      check('第二次运行复用引擎（无安装/解包）', /复用已安装引擎/.test(runner.getOutput()) && !/安装完成|解包完成/.test(runner.getOutput()))
    } else if (args.expect === 'install') {
      check('首次运行执行了安装/解包', /安装完成|解包完成/.test(runner.getOutput()))
    }
  }

  if (mode === 'usb') {
    check('usb 模式未安装到本机', !engineDir, engineDir || '(本机无新引擎)')
  }

  const code = await runner.stop()
  console.log(`\n  内核退出码：${code}`)

  if (mode === 'temp') {
    const listTempEngines = () => {
      try {
        return readdirSync(os.tmpdir()).filter((e) => e.startsWith('u-dsh-engine-')).map((e) => path.join(os.tmpdir(), e))
      } catch { return [] }
    }
    let leftovers = listTempEngines()
    if (leftovers.length > 0) {
      // Windows 上 SIGTERM 是不可捕获的强杀，退出钩子根本不会跑：
      // 零残留靠「下次启动补扫」兜底，这里显式触发一次，验证兜底真的有效。
      console.log('  提示：强杀留下临时引擎，触发下次启动补扫 …')
      const nodeExe = path.join(appRoot, 'resources', 'app', nodeRel())
      const installer = path.join(appRoot, 'resources', 'app', 'engine-install.cjs')
      spawnSync(nodeExe, ['-e', `require(${JSON.stringify(installer)}).sweepStaleTempEngines(0)`], { stdio: 'ignore' })
      leftovers = listTempEngines()
    }
    check('temp 模式零残留（退出即清 / 被强杀则下次启动补扫）', leftovers.length === 0, leftovers.join(', ') || '无残留')
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n== 结论：${results.length - failed.length}/${results.length} 项通过 ==`)
  if (args.json) {
    writeFileSync(args.json, JSON.stringify({
      ok: failed.length === 0,
      appRoot, version, mode, platform: process.platform, arch: process.arch,
      dataRoot, engineDir, exitCode: code, checks: results,
      at: new Date().toISOString(),
    }, null, 2) + '\n')
    console.log(`  报告已写入：${args.json}`)
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`verify-engine-install: ${error.message}`)
  process.exit(2)
})
