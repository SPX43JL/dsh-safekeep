import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { moveTargets, validateLiteralAbsolute } from './safe-trash.mjs'
import { safetyRoot, ensureStorage, checkNoLinks } from './storage.mjs'

const MARKER = '.ai-safety-owned.json'

function comparePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/u, '')
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

async function appendRegistry(entry) {
  const registryPath = path.join(safetyRoot(), 'state', 'task-temp.jsonl')
  await ensureStorage()
  await checkNoLinks(registryPath)
  await fs.mkdir(path.dirname(registryPath), { recursive: true, mode: 0o700 })
  await fs.appendFile(registryPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
}

async function readRegistry() {
  const registryPath = path.join(safetyRoot(), 'state', 'task-temp.jsonl')
  await checkNoLinks(registryPath)
  try {
    const text = await fs.readFile(registryPath, 'utf8')
    return text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function validatedTempRoot() {
  await ensureStorage()
  const expectedSafetyRoot = path.resolve(safetyRoot())
  if (!path.isAbsolute(expectedSafetyRoot) || comparePath(expectedSafetyRoot, path.parse(expectedSafetyRoot).root) || comparePath(expectedSafetyRoot, os.homedir())) {
    throw new Error(`AI safety root is not a safe dedicated absolute directory: ${expectedSafetyRoot}`)
  }
  await fs.mkdir(expectedSafetyRoot, { recursive: true, mode: 0o700 })
  const realSafetyRoot = await fs.realpath(expectedSafetyRoot)
  if (!comparePath(realSafetyRoot, expectedSafetyRoot)) {
    throw new Error(`AI safety root traverses a symbolic link or junction: ${expectedSafetyRoot} -> ${realSafetyRoot}`)
  }

  const expectedTaskRoot = path.join(realSafetyRoot, 'task-temp')
  await fs.mkdir(expectedTaskRoot, { recursive: true, mode: 0o700 })
  const realTaskRoot = await fs.realpath(expectedTaskRoot)
  if (!comparePath(realTaskRoot, expectedTaskRoot)) {
    throw new Error(`task temp root traverses a symbolic link or junction: ${expectedTaskRoot} -> ${realTaskRoot}`)
  }
  const stat = await fs.stat(realTaskRoot)
  if (!stat.isDirectory()) throw new Error(`task temp root is not a directory: ${realTaskRoot}`)
  return realTaskRoot
}

export async function createTaskTemp(label = 'task') {
  const root = await validatedTempRoot()
  const safeLabel = String(label).replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 32) || 'task'
  const directory = await fs.mkdtemp(path.join(root, `ai-agent-${safeLabel}-`))
  const realDirectory = await fs.realpath(directory)
  if (!comparePath(path.dirname(realDirectory), root)) throw new Error(`created task directory escaped its dedicated root: ${realDirectory}`)
  const marker = {
    schema: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    path: realDirectory,
  }
  await fs.writeFile(path.join(realDirectory, MARKER), `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  await appendRegistry({ ...marker, event: 'created' })
  return marker
}

export async function listTaskTemps(limit = 50) {
  const entries = await readRegistry()
  return entries.slice(-Math.max(1, limit)).reverse()
}

export async function retireTaskTemp(rawPath) {
  const absolutePath = validateLiteralAbsolute(rawPath)
  const root = await validatedTempRoot()
  if (!comparePath(path.dirname(absolutePath), root) || !path.basename(absolutePath).startsWith('ai-agent-')) {
    throw new Error(`task temp must be a direct ai-agent-* child of the dedicated task root: ${root}`)
  }
  const stat = await fs.lstat(absolutePath)
  if (stat.isSymbolicLink()) throw new Error(`task temp must not be a symbolic link or junction: ${absolutePath}`)
  const realPath = await fs.realpath(absolutePath)
  if (!comparePath(realPath, absolutePath)) throw new Error(`task temp resolves to a different path: ${absolutePath} -> ${realPath}`)

  const markerPath = path.join(absolutePath, MARKER)
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'))
  if (!comparePath(marker.path, absolutePath) || typeof marker.id !== 'string') {
    throw new Error('task temp ownership marker does not match the requested path')
  }
  const entries = await readRegistry()
  if (!entries.some((entry) => entry.event === 'created' && entry.id === marker.id && comparePath(entry.path, absolutePath))) {
    throw new Error('task temp directory is not present in the ownership registry')
  }
  const transactions = await moveTargets([absolutePath], { allowSafetyTaskTemp: true })
  await appendRegistry({ ...marker, event: 'retired', retiredAt: new Date().toISOString(), transactions: transactions.map((entry) => entry.id) })
  return transactions
}
