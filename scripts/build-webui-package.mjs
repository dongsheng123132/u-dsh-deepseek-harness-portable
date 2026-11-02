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
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createZipFromDirectory, verifyZipFile } from './lib/zip-archive.mjs'

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

/**
 * 运行时里只有 node 本体是必需的：
 *   include/、share/、npm 自带的 node_modules 全都可以不要。
 * 注意两种布局：Linux/macOS 是 lib/node_modules，Windows 的 zip 是根下 node_modules/。
 */
function pruneRuntime(dir) {
  for (const junk of [
    'include', 'share', 'CHANGELOG.md', 'README.md',
    'node_modules', path.join('lib', 'node_modules'),
    'corepack', 'corepack.cmd', 'npm', 'npm.cmd', 'npm.ps1', 'npx', 'npx.cmd', 'npx.ps1',
    'nodevars.bat', 'install_tools.bat',
    path.join('bin', 'npm'), path.join('bin', 'npx'), path.join('bin', 'corepack'),
  ]) {
    rmSync(path.join(dir, junk), { recursive: true, force: true })
  }
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

  // 1) 启动器 + JS（resources/app 下的 .cjs 全带上：启动器/引擎安装/设备钱包/钱包面板/充值）
  const sourceApp = path.join(root, 'portable-webui', 'resources', 'app')
  for (const name of readdirSync(sourceApp)) {
    if (name.endsWith('.cjs')) cpSync(path.join(sourceApp, name), path.join(app, name))
  }
  // 平台启动器：启动 / 钱包 / 充值（.bat 给 Windows，.command 给 macOS）
  for (const name of readdirSync(path.join(root, 'portable-webui'))) {
    if (!name.endsWith('.bat') && !name.endsWith('.command')) continue
    cpSync(path.join(root, 'portable-webui', name), path.join(out, name))
    if (name.endsWith('.command')) chmodSync(path.join(out, name), 0o755)
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

  // 2.5) 把「虾盘云钱包」客户端插件装进闭包，并在 dsh-web-app 的依赖里登记，
  //      否则 DSH 的 web 启动清单不会带上它（实测：不登记 → boot manifest 里没有该模块）。
  // 插件默认不打包：插槽契约没有公开文档，实测注册进 conversation 系插槽会把
  // dsh-client-ui-conversation 拖挂（整页 Failed to load plugins）。
  // 用 UDSH_WALLET_PLUGIN=1 才装进包，方便继续调试，不影响正式发布。
  const pluginSrc = path.join(root, 'portable-webui', 'plugin')
  if (process.env.UDSH_WALLET_PLUGIN === '1' && existsSync(pluginSrc)) {
    const pluginName = '@u-dsh/dsh-client-ui-xiapan-wallet'
    const pluginTarget = path.join(staging, 'node_modules', ...pluginName.split('/'))
    cpSync(pluginSrc, pluginTarget, { recursive: true })
    const webAppPkg = path.join(staging, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json')
    if (existsSync(webAppPkg)) {
      const manifest = JSON.parse(readFileSync(webAppPkg, 'utf8'))
      manifest.dependencies = { ...(manifest.dependencies ?? {}), [pluginName]: '0.1.0' }
      writeFileSync(webAppPkg, `${JSON.stringify(manifest, null, 2)}\n`)

      // 在 bundle 自己的 patch 文件里追加一行（缩进 4 空格 → 追加到文件末尾那条 insert 列表里）。
      // 注意：不能写进用户的 profile patch —— 顶层多一条 `- insert:` 会顶掉 bundle 的插入列表，
      // 实测表现为 dsh-client-ui-conversation 等 8 个插件 pending/failed、界面白屏报 Failed to load plugins。
      const patchFile = path.join(staging, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'cordis.patch.yml')
      if (existsSync(patchFile)) {
        const text = readFileSync(patchFile, 'utf8')
        if (!text.includes('xiapan-wallet')) {
          appendFileSync(patchFile, `\n    # U-DSH：虾盘云设备钱包（余额 / 一键充值），挂在 composer 工具条\n    - id: xiapan-wallet\n      name: '${pluginName}'\n`)
        }
        log(`已登记钱包插件到 dsh-web-app 的 patch 层：${pluginName}`)
      }
      log(`已装入钱包插件：${pluginName}`)
    } else {
      log('警告：闭包里没有 dsh-web-app，钱包插件未登记')
    }
  }

  // 3) 闭包 → engine.tar.gz
  const tarPath = path.join(app, 'engine.tar.gz')
  log('打包 engine.tar.gz …')
  execFileSync('tar', ['-czf', tarPath, '-C', staging, 'node_modules', 'package.json'], { stdio: 'inherit' })
  rmSync(staging, { recursive: true, force: true })
  for (const dir of pendingCleanup) rmSync(dir, { recursive: true, force: true })
  log(`engine.tar.gz: ${mb(statSync(tarPath).size)}`)

  // 4) engine.json + 空数据目录
  // 把归档的 SHA-256 写进 engine.json：客户机首次解包前先校验，
  // U 盘掉数据/拷贝不完整能当场报「请重新拷贝」，而不是解到一半报诡异错误。
  const sha256 = createHash('sha256').update(readFileSync(tarPath)).digest('hex')
  writeFileSync(path.join(app, 'engine.json'), `${JSON.stringify({
    schemaVersion: 1, version, engine: 'engine.tar.gz', sha256,
  }, null, 2)}\n`)
  log(`engine.json: version=${version} sha256=${sha256.slice(0, 16)}…`)
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
    // 一律走 scripts/lib/zip-archive.mjs：Win/mac/Linux 同一段代码，产物字节级一致。
    //
    // 这里曾经按平台分叉，两条路都留了坑：
    //  - Windows 用 .NET `ZipFile.CreateFromDirectory`：条目名是反斜杠、external_attr 恒 0
    //    （`create_system=0`/FAT → 解压后 .command 全变 0644，macOS 上双击报权限不足）；
    //  - macOS 用 bsdtar `tar -a`：名字和执行位对，但换行原样搬 —— Windows 检出带 CRLF 时
    //    `.command` 里就是 `#!/bin/bash\r`，macOS 报 bad interpreter。
    // 现在由写入器统一保证：正斜杠条目名、POSIX 权限位写进 external_attr 高位、
    // POSIX 脚本 LF / Windows 脚本 CRLF、目录条目结尾带 `/`。
    const written = createZipFromDirectory({ sourceDir: out, zipPath, includeBaseDirectory: true, log })
    log(`zip: ${mb(written.bytes)}（可执行条目 ${written.executableCount}，换行已规整 ${written.convertedCrlfCount}）`)

    // 打完立刻自检：宁可在 CI 里红，也不要再把一个「能解压不能用」的包发出去。
    const report = verifyZipFile(zipPath)
    if (!report.ok) {
      for (const problem of report.problems.slice(0, 20)) {
        console.error(`build-webui: zip 自检失败 [${problem.code}] ${problem.entry ?? '<整个包>'} —— ${problem.message}`)
      }
      throw new Error(`zip 自检未通过（${report.problems.length} 项），产物已留在 ${zipPath} 供排查`)
    }
    log(`zip 自检通过：${report.summary.entryCount} 条目 / 可执行 ${report.summary.executableCount}`)
  }
}

main().catch((error) => {
  console.error(`build-webui: ${error.message}`)
  process.exit(1)
})
