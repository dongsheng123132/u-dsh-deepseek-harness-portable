/**
 * 拦住"打得出包但包是坏的"这种最危险的成功。
 *
 * 自 v0.2.0 起内核（Node 运行时 + DSH 依赖闭包）随包 vendor，而
 * `scripts/prepare-vendor.mjs` 目前只产出 win32-x64。在没有对应平台
 * vendor 产物的情况下跑 `dist:mac` / `dist:linux`，electron-builder 会
 * 照常成功，打出一个缺内核的壳——用户拿到手才发现起不来。
 *
 * 要解禁某个平台：先让 prepare-vendor 能产出它的 runtime + 闭包，
 * 在干净机上验过，再从 UNSUPPORTED 里删掉，并更新 docs/ROADMAP.md。
 */
const UNSUPPORTED = {
  mac: 'macOS',
  linux: 'Linux',
}

const target = process.argv[2]
const label = UNSUPPORTED[target]

if (label) {
  process.stderr.write(
    `\n[guard] 拒绝为 ${label} 打包。\n\n` +
    `  自 v0.2.0 起内核随包 vendor，但 scripts/prepare-vendor.mjs 目前只产出 win32-x64。\n` +
    `  继续打包会得到一个缺内核的壳：构建会成功，用户双击才发现起不来。\n\n` +
    `  本轮范围是 Windows x64 单平台，见 docs/ROADMAP.md。\n` +
    `  确实要支持 ${label}，先让 prepare-vendor 产出该平台闭包并在干净机上验过，\n` +
    `  再从 scripts/guard-unsupported-target.mjs 的 UNSUPPORTED 里删掉。\n\n`,
  )
  process.exit(1)
}

process.stderr.write(`[guard] 未知目标 ${String(target)}\n`)
process.exit(1)
