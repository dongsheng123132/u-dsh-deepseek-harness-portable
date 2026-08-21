import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  checkRegistryBundle,
  generatedTextMatches,
  materializeRegistryBundle,
  stableStringify,
} from 'action-parity/src/generator.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'generated')
const checkMode = process.argv.includes('--check')
const bundle = await exportBundle()

if (checkMode) {
  const result = await checkRegistryBundle(bundle, output, { typescript: true })
  result.files.push(await checkFile(
    path.join(output, 'registry-bundle.json'),
    `${stableStringify(bundle, 2)}\n`,
  ))
  result.ok = result.files.every(({ status }) => status === 'current')
  for (const file of result.files) process.stdout.write(`${file.status}\t${file.path}\n`)
  process.exitCode = result.ok ? 0 : 1
} else {
  await materializeRegistryBundle(bundle, output, { typescript: true })
  await writeFile(path.join(output, 'registry-bundle.json'), `${stableStringify(bundle, 2)}\n`, 'utf8')
  process.stdout.write(`Generated U-DSH ActionParity artifacts in ${output}\n`)
}

function exportBundle() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'src', 'cli.js'), 'export'], {
      cwd: root,
      env: {
        ...process.env,
        UCLAW_API_BASE_URL: 'http://127.0.0.1:9/v1',
        UCLAW_PAY_BASE_URL: 'http://127.0.0.1:9',
      },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(`U-DSH registry exporter exited with ${code}`))
      try { resolve(JSON.parse(stdout)) } catch (error) {
        reject(new Error(`U-DSH registry exporter returned invalid JSON: ${error.message}`))
      }
    })
  })
}

async function checkFile(target, expected) {
  try {
    return {
      path: target,
      status: generatedTextMatches(await readFile(target, 'utf8'), expected) ? 'current' : 'drifted',
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: target, status: 'missing' }
    throw error
  }
}
