import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function readTextIfExists(filename) {
  try {
    return await readFile(filename, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

export async function writeTextAtomic(filename, text) {
  await mkdir(path.dirname(filename), { recursive: true })
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`,
  )
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, filename)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}
