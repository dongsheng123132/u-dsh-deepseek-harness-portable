#!/usr/bin/env node
/**
 * 第三方许可清单生成器 —— M5 开源发布的许可合规门禁。
 *
 * 我们随发布包分发了四类第三方软件的完整副本，全部要附许可证：
 *   1. DSH 依赖闭包       vendor/harness/node_modules（嵌套遍历，不能只扫顶层——
 *                          npm/pnpm 会把版本冲突的传递依赖留在依赖者自己的 node_modules 下，
 *                          遍历方式与 scripts/prepare-vendor.mjs 的 findSymlinkOrBin 保持一致）
 *   2. Node.js 运行时      vendor/runtime/win32-x64/（LICENSE 聚合了 Node 全部内置依赖，含 npm）
 *   3. Electron            node_modules/electron（Chromium 部分由 electron-builder 自动放
 *                          LICENSES.chromium.html 进包根，这里收 Electron 自身的 LICENSE）
 *   4. 应用生产依赖        package.json dependencies（随 build.files 的 node_modules/**​ 打进包）
 *
 * 产出（都进 git，是合规凭据不是构建产物）：
 *   third-party-licenses/NOTICES.md     人读：每个包一节，含许可证原文全文
 *   third-party-licenses/manifest.json  机器读：名称/版本/许可证标识/来源/文件清单
 *
 * 用法：
 *   node scripts/generate-third-party-licenses.mjs           # 生成/刷新两份清单
 *   node scripts/generate-third-party-licenses.mjs --check   # 纯本地校验，不联网：
 *     - 闭包里有、清单里没有（或清单陈旧）→ 退出码 1，列出漂移
 *     - 许可证字段缺失 / UNLICENSED / SEE LICENSE IN / 找不到许可原文 → 退出码 1，
 *       列出待人工确认清单，不许静默放过
 *     - 出现 GPL / AGPL / LGPL 全系列（copyleft 传染性）→ 退出码 1 并高亮。
 *       闭源商业分发下这是重大风险，必须让人立刻看到，生成器不做“应该没事”的判断
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const harnessModules = path.join(root, 'vendor', 'harness', 'node_modules')
const runtimeDir = path.join(root, 'vendor', 'runtime', 'win32-x64')
const outputDir = path.join(root, 'third-party-licenses')
const noticesFile = path.join(outputDir, 'NOTICES.md')
const manifestFile = path.join(outputDir, 'manifest.json')
const checkMode = process.argv.includes('--check')

function log(message) {
  process.stdout.write(`third-party-licenses: ${message}\n`)
}

function fail(message) {
  process.stderr.write(`third-party-licenses: ${message}\n`)
  process.exitCode = 1
}

function relative(target) {
  return path.relative(root, target).split(path.sep).join('/')
}

/** LICENSE / LICENCE / LICENSE.md / COPYING / NOTICE 等各种大小写与后缀变体。 */
const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying|notice|copyright)([-._][\w.+-]*)?$/i

/** 只有这些算“许可证正文”；NOTICE/COPYRIGHT 只随附，不能单独满足“有许可原文”。 */
const LICENSE_TEXT_PATTERN = /^(licen[cs]e|copying)([-._][\w.+-]*)?$/i

/** GPL/AGPL/LGPL 全系列。前置断言防止 LGPL 里的 GPL 被重复命中或 SGML 之类误伤。 */
const COPYLEFT_PATTERN = /(?<![A-Za-z])(A?GPL|LGPL)(?![A-Za-z])/i

/** 收集包根目录下的许可相关文件（不递归——按 npm 惯例许可文件都在包根）。 */
function collectLicenseFiles(packageDir) {
  const files = []
  let entries = []
  try { entries = readdirSync(packageDir, { withFileTypes: true }) } catch { return files }
  for (const entry of entries) {
    if (!entry.isFile() || !LICENSE_FILE_PATTERN.test(entry.name)) continue
    files.push(entry.name)
  }
  return files.sort((a, b) => a.localeCompare(b))
}

/** 把 package.json 的 license / licenses（旧格式）归一成一个表达式字符串。 */
function normalizeLicenseField(manifest) {
  const { license, licenses } = manifest
  if (typeof license === 'string' && license.trim() !== '') return { expression: license.trim(), source: 'license' }
  if (license && typeof license === 'object' && typeof license.type === 'string') {
    return { expression: license.type.trim(), source: 'license.type' }
  }
  if (Array.isArray(licenses) && licenses.length > 0) {
    const parts = licenses.map((item) => (typeof item === 'string' ? item : item?.type)).filter(Boolean)
    if (parts.length > 0) return { expression: parts.join(' OR '), source: 'licenses[]' }
  }
  return { expression: null, source: null }
}

function normalizeRepository(repository) {
  if (typeof repository === 'string') return repository
  if (repository && typeof repository.url === 'string') return repository.url
  return null
}

function normalizeAuthor(author) {
  if (typeof author === 'string') return author
  if (author && typeof author.name === 'string') {
    return author.email ? `${author.name} <${author.email}>` : author.name
  }
  return null
}

/** 判定这个包需要人看的原因；返回空数组即合规通过。 */
function reviewReasons(entry) {
  const reasons = []
  if (!entry.license) reasons.push('package.json 缺少 license/licenses 字段')
  else if (/^UNLICENSED$/i.test(entry.license)) reasons.push('license 为 UNLICENSED（不许分发）')
  else if (/^SEE LICENSE/i.test(entry.license)) reasons.push(`license 为「${entry.license}」，需逐个确认实际条款`)
  if (!entry.licenseFiles.some((name) => LICENSE_TEXT_PATTERN.test(name))) {
    reasons.push('包内找不到许可证原文文件（LICENSE/LICENCE/COPYING 变体）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 闭包遍历 —— 与 prepare-vendor.mjs 的递归口径一致：跳过 .bin，展开 scope，
// 进入每个包之后继续钻它自己的 node_modules（嵌套的传递依赖就藏在那里）。
// ---------------------------------------------------------------------------

function walkNodeModules(nodeModulesDir, origin, sink) {
  let entries = []
  try { entries = readdirSync(nodeModulesDir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name === '.bin' || entry.name.startsWith('.')) continue
    const target = path.join(nodeModulesDir, entry.name)
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(target, { withFileTypes: true })) {
        if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue
        visitPackage(path.join(target, scoped.name), origin, sink)
      }
    } else {
      visitPackage(target, origin, sink)
    }
  }
}

function visitPackage(packageDir, origin, sink) {
  const manifestPath = path.join(packageDir, 'package.json')
  if (existsSync(manifestPath)) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      throw new Error(`无法解析 ${relative(manifestPath)}：${error.message}`)
    }
    if (manifest?.name && manifest?.version) {
      addPackage(sink, packageDir, manifest, origin)
    }
  }
  walkNodeModules(path.join(packageDir, 'node_modules'), origin, sink)
}

function addPackage(sink, packageDir, manifest, origin) {
  const { expression, source } = normalizeLicenseField(manifest)
  const key = `${manifest.name}@${manifest.version}`
  const existing = sink.get(key)
  if (existing) {
    // 同名同版本在闭包多处出现（嵌套去重），只记路径，不重复收文本。
    if (!existing.paths.includes(relative(packageDir))) existing.paths.push(relative(packageDir))
    return
  }
  const licenseFiles = collectLicenseFiles(packageDir)
  const entry = {
    name: manifest.name,
    version: manifest.version,
    license: expression,
    licenseSource: source,
    repository: normalizeRepository(manifest.repository),
    author: normalizeAuthor(manifest.author),
    origin,
    paths: [relative(packageDir)],
    licenseFiles,
    copyleft: Boolean(expression && COPYLEFT_PATTERN.test(expression)),
  }
  entry.reviewReasons = reviewReasons(entry)
  sink.set(key, entry)
}

// ---------------------------------------------------------------------------
// 四个来源的收集
// ---------------------------------------------------------------------------

function collectHarness(sink) {
  if (!existsSync(harnessModules)) {
    throw new Error(`找不到 ${relative(harnessModules)}——先跑 npm run prepare:vendor 生成随包闭包`)
  }
  walkNodeModules(harnessModules, 'harness', sink)
}

function collectRuntime(sink) {
  const stampFile = path.join(runtimeDir, '.udsh-runtime.json')
  const licenseFile = path.join(runtimeDir, 'LICENSE')
  if (!existsSync(licenseFile)) {
    throw new Error(`找不到 ${relative(licenseFile)}——先跑 npm run prepare:vendor 生成随包运行时`)
  }
  let version = null
  try { version = JSON.parse(readFileSync(stampFile, 'utf8'))?.nodeVersion ?? null } catch { /* 版本戳缺失走 null */ }
  const entry = {
    name: 'Node.js (随包运行时)',
    version: version ?? '(缺版本戳，先跑 prepare:vendor)',
    license: 'MIT AND (Node.js 内置依赖各自条款，见 LICENSE 聚合全文)',
    licenseSource: 'runtime LICENSE',
    repository: 'https://github.com/nodejs/node',
    author: 'Node.js contributors',
    origin: 'runtime',
    paths: [relative(runtimeDir)],
    licenseFiles: ['LICENSE'],
    copyleft: false,
    reviewReasons: version ? [] : ['运行时缺少 .udsh-runtime.json 版本戳'],
  }
  sink.set(`node-runtime@${entry.version}`, entry)
}

function collectElectron(sink) {
  const electronDir = path.join(root, 'node_modules', 'electron')
  if (!existsSync(path.join(electronDir, 'package.json'))) {
    throw new Error('找不到 node_modules/electron——先跑 npm install')
  }
  visitPackageShallow(electronDir, 'electron', sink)
}

/** 只收这个包本身，不钻它的 node_modules（Electron 的 devDeps 不随包）。 */
function visitPackageShallow(packageDir, origin, sink) {
  const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
  addPackage(sink, packageDir, manifest, origin)
}

/** 应用自身的生产依赖（build.files 把 node_modules 打进包，devDeps 被 electron-builder 剪掉）。 */
function collectAppDependencies(sink) {
  const rootManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const queue = Object.keys(rootManifest.dependencies ?? {})
  const seen = new Set()
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    const packageDir = path.join(root, 'node_modules', ...name.split('/'))
    if (!existsSync(path.join(packageDir, 'package.json'))) {
      throw new Error(`生产依赖 ${name} 未安装——先跑 npm install`)
    }
    // file: 依赖在 node_modules 下是 junction，读真实位置但记录包内路径。
    const realDir = realpathSync(packageDir)
    const manifest = JSON.parse(readFileSync(path.join(realDir, 'package.json'), 'utf8'))
    addPackage(sink, realDir, manifest, 'app')
    queue.push(...Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }))
  }
}

function collectAll() {
  const sink = new Map()
  collectHarness(sink)
  collectRuntime(sink)
  collectElectron(sink)
  collectAppDependencies(sink)
  return sink
}

// ---------------------------------------------------------------------------
// 统计与产出
// ---------------------------------------------------------------------------

function licenseCounts(entries) {
  const counts = new Map()
  for (const entry of entries) {
    const label = entry.origin === 'runtime' ? 'Node.js 聚合许可（见 LICENSE 全文）' : (entry.license ?? '（缺失，待人工确认）')
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

function printSummary(entries) {
  const flagged = entries.filter((entry) => entry.reviewReasons.length > 0)
  const copyleft = entries.filter((entry) => entry.copyleft)
  log(`覆盖 ${entries.length} 个组件（harness ${entries.filter((e) => e.origin === 'harness').length}`
    + ` / runtime ${entries.filter((e) => e.origin === 'runtime').length}`
    + ` / electron ${entries.filter((e) => e.origin === 'electron').length}`
    + ` / app ${entries.filter((e) => e.origin === 'app').length}）`)
  log('按许可证类型统计：')
  for (const [license, count] of licenseCounts(entries)) {
    log(`  ${String(count).padStart(4)}  ${license}`)
  }
  log(`需人工确认：${flagged.length} 个；copyleft（GPL/AGPL/LGPL 系）：${copyleft.length} 个`)
  return { flagged, copyleft }
}

function renderLicenseText(entry) {
  const chunks = []
  for (const fileName of entry.licenseFiles) {
    const filePath = path.join(root, ...entry.paths[0].split('/'), fileName)
    let text
    try { text = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').trimEnd() } catch { continue }
    chunks.push(`#### ${fileName}\n\n\`\`\`\`text\n${text}\n\`\`\`\``)
  }
  return chunks
}

const ORIGIN_LABELS = {
  harness: 'DSH 依赖闭包（resources/harness/node_modules）',
  runtime: 'Node.js 运行时（resources/runtime/win32-x64）',
  electron: 'Electron 桌面运行时（发布包主程序）',
  app: '应用生产依赖（resources/app/node_modules）',
}

async function generate() {
  const sink = collectAll()
  const entries = [...sink.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  const { flagged, copyleft } = printSummary(entries)

  const generatedAt = new Date().toISOString()
  const manifest = {
    schemaVersion: 1,
    generatedAt,
    generator: 'scripts/generate-third-party-licenses.mjs',
    packageCount: entries.length,
    licenseCounts: Object.fromEntries(licenseCounts(entries)),
    needsReviewCount: flagged.length,
    copyleftCount: copyleft.length,
    packages: entries.map((entry) => ({
      name: entry.name,
      version: entry.version,
      license: entry.license,
      licenseSource: entry.licenseSource,
      repository: entry.repository,
      author: entry.author,
      origin: entry.origin,
      paths: entry.paths,
      licenseFiles: entry.licenseFiles,
      copyleft: entry.copyleft,
      reviewReasons: entry.reviewReasons,
    })),
  }

  const lines = []
  lines.push('# 第三方软件许可声明（NOTICES）')
  lines.push('')
  lines.push('> 本文件由 `scripts/generate-third-party-licenses.mjs` 自动生成，**不要手改**；')
  lines.push('> 闭包变了就重跑 `npm run licenses:generate`。机器读的结构化清单在同目录 `manifest.json`。')
  lines.push('')
  lines.push(`生成时间：${generatedAt}　覆盖组件：${entries.length} 个`)
  lines.push('')
  lines.push('U-DSH Portable 发布包内含以下第三方软件的完整副本。各软件版权归其原作者所有，')
  lines.push('按各自许可证条款分发；许可证原文逐包附后。Electron 内置 Chromium 等组件的许可')
  lines.push('由 electron-builder 打包时自动放置在包根的 `LICENSES.chromium.html`。')
  lines.push('')
  lines.push('## 按许可证类型统计')
  lines.push('')
  lines.push('| 许可证 | 数量 |')
  lines.push('|---|---:|')
  for (const [license, count] of licenseCounts(entries)) {
    lines.push(`| ${license.replace(/\|/g, '\\|')} | ${count} |`)
  }
  lines.push('')
  if (copyleft.length > 0) {
    lines.push('## ⚠️ Copyleft（GPL/AGPL/LGPL 系）组件——分发前必须人工确认')
    lines.push('')
    for (const entry of copyleft) {
      lines.push(`- **${entry.name}@${entry.version}** — \`${entry.license}\`（位于 \`${entry.paths.join('`、`')}\`）`)
    }
    lines.push('')
  }
  if (flagged.length > 0) {
    lines.push('## ⚠️ 需人工确认的组件')
    lines.push('')
    for (const entry of flagged) {
      lines.push(`- **${entry.name}@${entry.version}** — ${entry.reviewReasons.join('；')}`)
    }
    lines.push('')
  }
  let currentOrigin = null
  const byOrigin = ['harness', 'runtime', 'electron', 'app']
  for (const origin of byOrigin) {
    const originEntries = entries.filter((entry) => entry.origin === origin)
    if (originEntries.length === 0) continue
    if (currentOrigin !== origin) {
      currentOrigin = origin
      lines.push(`## ${ORIGIN_LABELS[origin]}（${originEntries.length} 个）`)
      lines.push('')
    }
    for (const entry of originEntries) {
      lines.push(`### ${entry.name}@${entry.version}`)
      lines.push('')
      lines.push(`- 许可证：\`${entry.license ?? '（缺失，待人工确认）'}\``)
      if (entry.repository) lines.push(`- 仓库：${entry.repository}`)
      if (entry.author) lines.push(`- 作者：${entry.author}`)
      lines.push(`- 闭包路径：\`${entry.paths.join('`、`')}\``)
      if (entry.copyleft) lines.push('- **⚠️ copyleft 许可证，分发前必须人工确认**')
      for (const reason of entry.reviewReasons) lines.push(`- **⚠️ ${reason}**`)
      lines.push('')
      const texts = renderLicenseText(entry)
      if (texts.length > 0) {
        lines.push(...texts.flatMap((chunk) => [chunk, '']))
      }
    }
  }

  await mkdir(outputDir, { recursive: true })
  const noticesBody = `${lines.join('\n')}\n`
  await writeFile(noticesFile, noticesBody)
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  log(`已写入 ${relative(noticesFile)}（${(Buffer.byteLength(noticesBody) / 1024 / 1024).toFixed(1)}MB）`
    + ` 与 ${relative(manifestFile)}（${(statSync(manifestFile).size / 1024).toFixed(0)}KB）`)
  if (copyleft.length > 0) {
    log(`注意：闭包里有 ${copyleft.length} 个 copyleft 组件，licenses:check 会失败直到人工确认——这是设计行为`)
  }
}

// ---------------------------------------------------------------------------
// --check —— 不联网的合规门禁
// ---------------------------------------------------------------------------

function hashKey(entry) {
  return createHash('sha256').update(`${entry.name}@${entry.version}:${entry.license ?? ''}`).digest('hex')
}

async function check() {
  if (!existsSync(manifestFile)) {
    fail(`缺少 ${relative(manifestFile)}——先跑 npm run licenses:generate`)
    return
  }
  if (!existsSync(noticesFile)) {
    fail(`缺少 ${relative(noticesFile)}——先跑 npm run licenses:generate`)
    return
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const recorded = new Map((manifest.packages ?? []).map((entry) => [`${entry.name}@${entry.version}`, entry]))

  const sink = collectAll()
  const entries = [...sink.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  const { flagged, copyleft } = printSummary(entries)

  const missing = []
  const drifted = []
  for (const entry of entries) {
    const key = `${entry.name}@${entry.version}`
    const record = recorded.get(key)
    if (!record) { missing.push(key); continue }
    if (hashKey(record) !== hashKey(entry)) drifted.push(`${key}（license 记录「${record.license}」≠ 实际「${entry.license}」）`)
    recorded.delete(key)
  }
  const stale = [...recorded.keys()]

  let failed = false
  if (missing.length > 0) {
    failed = true
    fail(`闭包里存在但清单缺失 ${missing.length} 个包（重跑 npm run licenses:generate）：`)
    for (const key of missing) fail(`  - ${key}`)
  }
  if (stale.length > 0) {
    failed = true
    fail(`清单里有但闭包已不存在 ${stale.length} 个包（清单陈旧，重跑 npm run licenses:generate）：`)
    for (const key of stale) fail(`  - ${key}`)
  }
  if (drifted.length > 0) {
    failed = true
    fail(`许可证记录与实际漂移 ${drifted.length} 处（重跑 npm run licenses:generate）：`)
    for (const item of drifted) fail(`  - ${item}`)
  }
  if (flagged.length > 0) {
    failed = true
    fail(`${flagged.length} 个包需要人工确认，不许静默放过：`)
    for (const entry of flagged) fail(`  - ${entry.name}@${entry.version}：${entry.reviewReasons.join('；')}`)
  }
  if (copyleft.length > 0) {
    failed = true
    fail('════════════════════════════════════════════════════════════')
    fail(`⚠️ 发现 ${copyleft.length} 个 copyleft（GPL/AGPL/LGPL 系）组件——闭源商业分发重大风险：`)
    for (const entry of copyleft) {
      fail(`  - ${entry.name}@${entry.version} → ${entry.license}`)
      fail(`    位置：${entry.paths.join('、')}`)
    }
    fail('  必须人工逐个确认分发方式是否合规（动态链接的 LGPL ≠ 自动没事），生成器不代作判断。')
    fail('════════════════════════════════════════════════════════════')
  }
  if (failed) {
    fail('licenses:check 未通过。')
    return
  }
  log(`--check 通过：${entries.length} 个组件全部有清单记录与许可原文，无 copyleft，无待确认项。`)
}

if (checkMode) {
  await check()
} else {
  await generate()
}
