import { mkdir, rm, symlink } from 'node:fs/promises'
import path from 'node:path'

/**
 * 启动前探测数据盘能不能建 NTFS junction。
 * DSH 每次启动都要在 dsh-home/profiles/node_modules 下建 junction，exFAT / FAT32
 * 直接 EISDIR（见 ROADMAP 既有决定）。与其等 DSH 启动到一半抛裸异常，
 * 不如在这里花几毫秒做一次真实能力探测，失败时给出「换 NTFS」的人话。
 */
export async function probeJunctionSupport(baseDir, {
  platform = process.platform,
  fsOps = { mkdir, rm, symlink },
} = {}) {
  // junction 是 Windows 概念；其余平台的 symlink 由 DSH 自己处理，不在这条红线上。
  if (platform !== 'win32') return { ok: true, skipped: true }
  const probeRoot = path.join(baseDir, `.udsh-junction-probe-${process.pid}-${Date.now()}`)
  const target = path.join(probeRoot, 'target')
  const link = path.join(probeRoot, 'link')
  try {
    await fsOps.mkdir(target, { recursive: true })
    await fsOps.symlink(target, link, 'junction')
    return { ok: true }
  } catch (error) {
    return { ok: false, error }
  } finally {
    await fsOps.rm(probeRoot, { recursive: true, force: true }).catch(() => {})
  }
}
