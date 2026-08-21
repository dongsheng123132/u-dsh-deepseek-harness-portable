import { existsSync, globSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import YAML from 'yaml'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const contract = YAML.parse(readFileSync(path.join(root, '.shadowfork', 'upstream.yaml'), 'utf8'))
const schema = JSON.parse(readFileSync(path.join(root, '.shadowfork', 'derivation-contract.v1alpha1.schema.json'), 'utf8'))
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
const errors = []

if (!ajv.validate(schema, contract)) {
  errors.push(...(ajv.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message}`))
}

for (const item of contract.identity ?? []) {
  const filename = path.join(root, item.file)
  if (!existsSync(filename)) errors.push(`identity 文件不存在：${item.file}`)
  if (item.path && existsSync(filename)) {
    const value = structuredValue(filename)
    if (!jsonPathExists(value, item.path)) errors.push(`identity 路径不存在：${item.file} ${item.path}`)
  }
}

for (const item of contract.protected ?? []) {
  if (item.file && !existsSync(path.join(root, item.file))) errors.push(`protected 文件不存在：${item.file}`)
  if (item.glob && globSync(item.glob, { cwd: root }).length === 0) errors.push(`protected glob 无匹配：${item.glob}`)
}

for (const item of contract.extensionPoints ?? []) {
  const target = item.file ?? item.dir
  if (!existsSync(path.join(root, target))) errors.push(`extensionPoint 不存在：${target}`)
}

if (errors.length > 0) {
  process.stdout.write(`${JSON.stringify({ ok: false, errors }, null, 2)}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`${JSON.stringify({ ok: true, contract: '.shadowfork/upstream.yaml' })}\n`)
}

function structuredValue(filename) {
  const text = readFileSync(filename, 'utf8')
  return /\.ya?ml$/i.test(filename) ? YAML.parse(text) : JSON.parse(text)
}

function jsonPathExists(value, expression) {
  if (!expression.startsWith('$.')) return false
  let current = value
  for (const token of expression.slice(2).split('.')) {
    if (!current || !Object.prototype.hasOwnProperty.call(current, token)) return false
    current = current[token]
  }
  return true
}
