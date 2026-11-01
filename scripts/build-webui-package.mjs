#!/usr/bin/env node
/**
 * 组装 WebUI 便携包（单文件归档形态）。
 *
 *   U-DSH-WebUI-Portable-<版本>-win-mac/
 *   ├── 启动 U-DSH Web.bat / .command
 *   ├── data/dsh-home/                     ← 数据随盘（首次运行自动建）
 *   └── resources/app/
 *       ├── web-launch.cjs / engine-install.cjs
 *       ├── engine.json                    ← {version, engine}
 *       ├── engine.tar.gz                  ← DSH 闭包（node_modules + package.json）
 *       └── runtime/node-win-x64/node.exe  ← 引导用 Node（同时也是装到本机的运行时）
 *           runtime/node-mac-arm64/bin/node
 *
 * 为什么是一个归档：exFAT 常见 128KB 簇 + 一万多个小文件，会让"解压到 U 盘"
 * 膨胀到 1.4GB、拷进去几十分钟（实测）。单文件归档后 U 盘上只有 21 个文件，
 * 首次运行在本机原地解包（实测 8s / 114MB），Node 本来就不在 U 盘上跑。
 *
 * 用法：
 *   node scripts/build-webui-package.mjs --out dist/webui \
 *        [--harness vendor/harness] \
 *        [--runtime node-win-x64=vendor/runtime/win32-x64] \
 *        [--runtime node-mac-arm64=/path/to/node-v24.19.0-darwin-arm64] \
 *        [--node-version 24.19.0]      # 给了就自动下载缺的 mac 运行时
 *        [--zip]                        # 顺手压成发布 zip
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const out = { runtimes: [], harness: path.join(root, 'vendor', 'harness'), out: null, zip: false, nodeVersion: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') out.out = argv[++i]
    else if (a === '--harness') out.harness = path.resolve(argv[++i])
    else if (a === '--runtime') out.runtimes.push(argv[++i])
    else if (a === '--node-version') out.nodeVersion = argv[++i]
    else if (a === '--zip') out.zip = true
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return out
}

const log = (m) => process.stdout.write(`build-webui: ${m}\n`)

function directorySize(p) {
  let total = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else { try { total += statSync(full).size } catch {} }
    }
  }
  walk(p)
  return total
}

const mb = (bytes) => `${(bytes / 1024 ** 2).toFixed(1)} MB`

/** 运行时里只有 bin/node(c.exe) 是必需的；include/、npm、share/ 全都可以不要。 */
function pruneRuntime(dir) {
  for (const junk of ['include', 'share', 'CHANGELOG.md', 'README.md']) {
    rmSync(path.join(dir, junk), { recursive: true, force: true })
  }
  const npm = path.join(dir, 'lib', 'node_modules')
  if (existsSync(npm)) rmSync(npm, { recursive: true, force: true })
}

async function downloadNode(version, target, outDir) {
  const os = target.startsWith('node-win') ? 'win-x64' : target.includes('x64') ? 'darwin-x64' : 'darwin-arm64'
  const ext = target.startsWith('node-win') ? 'zip' : 'tar.gz'
  const base = `node-v${version}-${os}`
  const url = `https://nodejs.org/dist/v${version}/${base}.${ext}`
  const tmp = path.join(outDir, `.download-${base}.${ext}`)
  log(`下载 ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()))
  const extractDir = path.join(outDir, `.extract-${base}`)
  rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })
  execFileSync('tar', ['-xf', tmp, '-C', extractDir], { stdio: 'inherit' })
  const inner = path.join(extractDir, base)
  rmSync(tmp, { force: true })
  return { dir: inner, extractDir }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.out) {
    console.log('用法：node scripts/build-webui-package.mjs --out <目录> [--harness vendor/harness] [--runtime name=dir]... [--node-version 24.19.0] [--zip]')
    process.exit(args.help ? 0 : 2)
  }
  const out = path.resolve(args.out)
  const app = path.join(out, 'resources', 'app')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(app, { recursive: true })

  if (!existsSync(path.join(args.harness, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))) {
    throw new Error(`闭包不完整：${args.harness}（先跑 UDSH_VENDOR_WEB_UI=1 npm run prepare:vendor）`)
  }
  const version = JSON.parse(readFileSync(path.join(args.harness, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version

  // 1) 启动器 + JS
  for (const name of ['web-launch.cjs', 'engine-install.cjs']) {
    cpSync(path.join(root, 'portable-webui', 'resources', 'app', name), path.join(app, name))
  }
  for (const name of ['启动 U-DSH Web.bat', '启动 U-DSH Web.command']) {
    cpSync(path.join(root, 'portable-webui', name), path.join(out, name))
  }
  cpSync(path.join(root, 'portable-webui', 'README.md'), path.join(out, 'README.md'))

  // 2) 运行时（引导 + 装到本机的那份）
  mkdirSync(path.join(app, 'runtime'), { recursive: true })
  const staging = path.join(out, '.tar-staging')
  mkdirSync(path.join(staging, 'node_modules'), { recursive: true })
  cpSync(path.join(args.harness, 'node_modules'), path.join(staging, 'node_modules'), { recursive: true, dereference: true })
  cpSync(path.join(args.harness, 'package.json'), path.join(staging, 'package.json'))

  const runtimes = [...args.runtimes]
  if (runtimes.length === 0 && args.nodeVersion) {
    runtimes.push(`node-win-x64=vendor/runtime/win32-x64`)
    runtimes.push(`node-mac-arm64=@download`)
    runtimes.push(`node-mac-x64=@download`)
  }
  const pendingCleanup = []
  for (const spec of runtimes) {
    const [name, rawDir] = spec.split('=')
    let dir = rawDir ? path.resolve(rawDir) : null
    if (!dir || rawDir === '@download') {
      if (!args.nodeVersion) throw new Error(`${name} 需要 --node-version 才能自动下载`)
      const dl = await downloadNode(args.nodeVersion, name, out)
      dir = dl.dir
      pendingCleanup.push(dl.extractDir)
    }
    if (!existsSync(dir)) throw new Error(`运行时不存在：${dir}`)
    const target = path.join(app, 'runtime', name)
    cpSync(dir, target, { recursive: true, dereference: true })
    pruneRuntime(target)
    log(`运行时 ${name}: ${mb(directorySize(target))}`)
  }

  // 3) 闭包 → engine.tar.gz
  const tarPath = path.join(app, 'engine.tar.gz')
  log('打包 engine.tar.gz …')
  execFileSync('tar', ['-czf', tarPath, '-C', staging, 'node_modules', 'package.json'], { stdio: 'inherit' })
  rmSync(staging, { recursive: true, force: true })
  for (const dir of pendingCleanup) rmSync(dir, { recursive: true, force: true })
  log(`engine.tar.gz: ${mb(statSync(tarPath).size)}`)

  // 4) engine.json + 空数据目录
  writeFileSync(path.join(app, 'engine.json'), `${JSON.stringify({ schemaVersion: 1, version, engine: 'engine.tar.gz' }, null, 2)}\n`)
  mkdirSync(path.join(out, 'data', 'dsh-home'), { recursive: true })

  const total = directorySize(out)
  const files = readdirSync(out, { recursive: true }).length
  log(`完成：${out}（${mb(total)}，${files} 个条目，DSH ${version}）`)

  if (args.zip) {
    const version2 = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
    const hasWin = runtimes.some((r) => r.startsWith('node-win'))
    const hasMac = runtimes.some((r) => r.startsWith('node-mac'))
    const platforms = hasWin && hasMac ? 'win-mac' : hasWin ? 'win' : 'mac'
    const zipPath = path.join(path.dirname(out), `U-DSH-WebUI-Portable-${version2}-${platforms}.zip`)
    rmSync(zipPath, { force: true })
    log(`压 zip：${zipPath}`)
    execFileSync('zip', ['-q', '-r', '-X', zipPath, path.basename(out)], { cwd: path.dirname(out), stdio: 'inherit' })
    log(`zip: ${mb(statSync(zipPath).size)}`)
  }
}

main().catch((error) => {
  console.error(`build-webui: ${error.message}`)
  process.exit(1)
})
