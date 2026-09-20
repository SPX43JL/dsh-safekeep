import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recordAudit } from './recovery.mjs'
import { assertNoLinks, assertOutsideVault, exists, writeExclusive } from './paths.mjs'
import { treeIntegrity, verifyTree, withTrashLock } from './transactions.mjs'
import { resolveMutationPath } from './guard-core.mjs'
import { safetyRoot, ensureStorage, secureDirectory, userKey } from './storage.mjs'

function comparePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/u, '')
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function validateLiteralAbsolute(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) throw new Error('target path is empty')
  if (rawPath !== rawPath.trim()) throw new Error(`leading or trailing whitespace is not allowed in a target path: ${JSON.stringify(rawPath)}`)
  if (rawPath.includes('\0')) throw new Error('target path contains NUL')
  if (!path.isAbsolute(rawPath)) throw new Error(`target must be an absolute path: ${rawPath}`)
  if (process.platform === 'win32' && /^\\\\[?.]\\/u.test(rawPath)) throw new Error(`Windows device namespace paths are not allowed: ${rawPath}`)
  if (/[*?\[\]{}]/u.test(rawPath)) throw new Error(`wildcards are not allowed: ${rawPath}`)
  if (/\$(?:env:)?[A-Za-z_]|\$\{|%[A-Za-z_][A-Za-z0-9_]*%|^~/u.test(rawPath)) {
    throw new Error(`unresolved environment or home shorthand is not allowed: ${rawPath}`)
  }
  if (rawPath.split(/[\\/]+/u).includes('..')) throw new Error(`parent traversal is not allowed: ${rawPath}`)
  const absolutePath = resolveMutationPath(rawPath, process.cwd())
  if (process.platform === 'win32' && absolutePath.slice(path.parse(absolutePath).root.length).includes(':')) {
    throw new Error(`alternate data stream paths are not allowed: ${rawPath}`)
  }
  return absolutePath
}

function assertNotProtected(absolutePath, options = {}) {
  assertOutsideVault(absolutePath)
  const userRoot = os.homedir()
  const exactProtectedPaths = [
    path.parse(absolutePath).root,
    userRoot,
    os.tmpdir(),
    process.cwd(),
    path.join(userRoot, 'Desktop'),
    path.join(userRoot, 'Documents'),
    path.join(userRoot, 'Downloads'),
  ]
  const exactMatch = exactProtectedPaths.find((candidate) => comparePath(absolutePath, candidate))
  if (exactMatch) throw new Error(`refusing to move protected root: ${absolutePath}`)

  const safetyTaskRoot = path.join(safetyRoot(), 'task-temp')
  const isOwnedTaskTemp = options.allowSafetyTaskTemp === true && isInside(absolutePath, safetyTaskRoot)
  const protectedTrees = [
    path.join(userRoot, '.codex'),
    path.join(userRoot, '.claude'),
    path.join(userRoot, '.dsh'),
    path.join(userRoot, '.ai-safety'),
    safetyRoot(),
    process.env.DSH_HOME,
    path.join(userRoot, '.ssh'),
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData,
  ].filter((candidate) => typeof candidate === 'string' && path.isAbsolute(candidate))
  const protectedTree = protectedTrees.find((candidate) => {
    if (isOwnedTaskTemp && comparePath(candidate, safetyRoot())) return false
    return comparePath(absolutePath, candidate) || isInside(absolutePath, candidate)
  })
  if (protectedTree) throw new Error(`refusing to move content inside protected tree ${protectedTree}: ${absolutePath}`)

  if (absolutePath.split(/[\\/]+/u).some((segment) => segment.toLowerCase() === '.git')) {
    throw new Error(`refusing to move Git metadata: ${absolutePath}`)
  }
}

async function isRegisteredTaskPath(absolutePath) {
  const taskRoot = path.join(safetyRoot(), 'task-temp')
  if (!isInside(absolutePath, taskRoot)) return false
  const owner = path.join(taskRoot, path.relative(taskRoot, absolutePath).split(path.sep)[0])
  if (!path.basename(owner).startsWith('ai-agent-')) return false
  const text = await fs.readFile(path.join(safetyRoot(), 'state', 'task-temp.jsonl'), 'utf8')
  return text.split(/\r?\n/u).filter(Boolean).some(line => { const entry = JSON.parse(line); return entry.event === 'created' && comparePath(entry.path, owner) })
}

async function resolveTarget(rawPath, options = {}) {
  const absolutePath = validateLiteralAbsolute(rawPath)
  const registered = await isRegisteredTaskPath(absolutePath)
  assertNotProtected(absolutePath, { ...options, allowSafetyTaskTemp: registered })
  await assertNoLinks(absolutePath)
  const stat = await fs.lstat(absolutePath)
  const realPath = await fs.realpath(absolutePath)
  return {
    rawPath,
    absolutePath,
    realPath,
    isSymbolicLink: stat.isSymbolicLink(),
    bytes: stat.isFile() ? stat.size : null,
    device: stat.dev,
    volume: process.platform === 'win32' ? path.parse(absolutePath).root.toLowerCase() : String(stat.dev),
  }
}

function assertNoOverlap(targets) {
  for (let left = 0; left < targets.length; left += 1) {
    for (let right = left + 1; right < targets.length; right += 1) {
      const a = targets[left].absolutePath
      const b = targets[right].absolutePath
      if (comparePath(a, b) || isInside(a, b) || isInside(b, a)) {
        throw new Error(`overlapping targets are not allowed in one operation: ${a} and ${b}`)
      }
    }
  }
}

async function chooseVaultRoot(target) {
  await ensureStorage()
  const userStat = await fs.stat(safetyRoot())
  if (userStat.dev === target.device) return path.join(safetyRoot(), 'recovery', 'trash')

  const volumeRoot = path.parse(target.absolutePath).root
  const key = await userKey()
  const volumeStorage = path.join(volumeRoot, `.dsh-safekeep-${key}`)
  try {
    await secureDirectory(volumeStorage)
    return path.join(volumeStorage, 'trash')
  } catch (e) {
    if (!['EACCES', 'EPERM'].includes(e.code)) throw e
    const siblingStorage = path.join(path.dirname(target.absolutePath), `._dsh-safekeep-${key}`)
    await secureDirectory(siblingStorage)
    return path.join(siblingStorage, 'trash')
  }
}

function transactionId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14)
  return `${stamp}-${randomBytes(5).toString('hex')}`
}

async function writeManifest(manifestPath, manifest) {
  const revisionRoot = path.join(path.dirname(manifestPath), 'revisions')
  await fs.mkdir(revisionRoot, { recursive: true, mode: 0o700 })
  const temporary = path.join(revisionRoot, `${Date.now()}-${randomBytes(8).toString('hex')}.json`)
  const data = `${JSON.stringify(manifest, null, 2)}\n`
  await writeExclusive(temporary, data)
  // Retain every revision; only the small current manifest pointer is replaced.
  const current = `${manifestPath}.${randomBytes(8).toString('hex')}.new`
  await writeExclusive(current, data)
  await fs.rename(current, manifestPath)
}

async function appendIndex(record) {
  const indexPath = path.join(safetyRoot(), 'recovery', 'trash-index.jsonl')
  await ensureStorage()
  await assertNoLinks(indexPath)
  await fs.mkdir(path.dirname(indexPath), { recursive: true, mode: 0o700 })
  await fs.appendFile(indexPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
}

async function moveGroup(targets) {
  const id = transactionId()
  const vaultRoot = await chooseVaultRoot(targets[0])
  const transactionRoot = path.join(vaultRoot, id)
  await assertNoLinks(vaultRoot)
  await fs.mkdir(vaultRoot, { recursive: true, mode: 0o700 })
  await fs.mkdir(transactionRoot, { recursive: false, mode: 0o700 })
  const entries = targets.map((target, index) => ({
    ...target,
    storedPath: path.join(transactionRoot, `${String(index + 1).padStart(3, '0')}-${path.basename(target.absolutePath)}`),
    moved: false,
  }))
  const manifestPath = path.join(transactionRoot, 'manifest.json')
  const manifest = {
    schema: 2,
    id,
    createdAt: new Date().toISOString(),
    state: 'planned',
    entries,
  }
  await writeManifest(manifestPath, manifest)
  await appendIndex({ id, manifestPath, createdAt: manifest.createdAt, state: manifest.state })

  const moved = []
  try {
    for (const entry of entries) {
      entry.integrity = await treeIntegrity(entry.absolutePath)
      await writeManifest(manifestPath, { ...manifest, state: 'moving', entries })
      await assertNoLinks(entry.absolutePath)
      if (await exists(entry.storedPath)) throw new Error('recovery destination unexpectedly exists')
      await fs.rename(entry.absolutePath, entry.storedPath)
      entry.moved = true
      moved.push(entry)
      await verifyTree(entry.storedPath, entry.integrity)
      await writeManifest(manifestPath, { ...manifest, state: 'moving', entries })
    }
  } catch (error) {
    const rollbackErrors = []
    for (const entry of moved.reverse()) {
      try {
        if (await exists(entry.absolutePath)) throw new Error(`rollback destination occupied; recovery copy retained: ${entry.absolutePath}`)
        await fs.rename(entry.storedPath, entry.absolutePath)
        entry.moved = false
      } catch (rollbackError) {
        rollbackErrors.push(String(rollbackError?.message ?? rollbackError))
      }
    }
    await writeManifest(manifestPath, {
      ...manifest,
      state: rollbackErrors.length === 0 ? 'rolled-back' : 'rollback-incomplete',
      entries,
      error: String(error?.message ?? error),
      rollbackErrors,
    })
    void recordAudit({ kind: 'safe-trash-move-failed', transactionId: id, manifestPath, error: String(error?.message ?? error), rollbackErrors }).catch(() => {})
    throw new Error(`reversible move failed and was ${rollbackErrors.length === 0 ? 'rolled back' : 'only partially rolled back'}: ${error?.message ?? error}`)
  }

  const finished = { ...manifest, completedAt: new Date().toISOString(), state: 'moved', entries }
  await writeManifest(manifestPath, finished)
  void recordAudit({ kind: 'safe-trash-move', transactionId: id, manifestPath, targets: entries.map((entry) => entry.absolutePath) }).catch(() => {})
  return { id, manifestPath, entries }
}

async function moveTargetsUnlocked(rawPaths, options = {}) {
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) throw new Error('at least one target is required')
  const targets = []
  for (const rawPath of rawPaths) targets.push(await resolveTarget(rawPath, options))
  assertNoOverlap(targets)

  const groups = new Map()
  for (const target of targets) {
    if (!groups.has(target.volume)) groups.set(target.volume, [])
    groups.get(target.volume).push(target)
  }
  const transactions = []
  for (const group of groups.values()) transactions.push(await moveGroup(group))
  return transactions
}

export async function moveTargets(rawPaths, options = {}) {
  return withTrashLock(() => moveTargetsUnlocked(rawPaths, options))
}

async function readIndex() {
  const indexPath = path.join(safetyRoot(), 'recovery', 'trash-index.jsonl')
  await assertNoLinks(indexPath)
  try {
    const text = await fs.readFile(indexPath, 'utf8')
    return text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

export async function listTransactions(limit = 50) {
  const records = await readIndex()
  const unique = new Map()
  for (const record of records) unique.set(record.id, record)
  const selected = [...unique.values()].slice(-Math.max(1, limit)).reverse()
  const results = []
  for (const record of selected) {
    try {
      const manifest = JSON.parse(await fs.readFile(record.manifestPath, 'utf8'))
      results.push({ id: record.id, state: manifest.state, createdAt: manifest.createdAt, manifestPath: record.manifestPath, targets: manifest.entries.map((entry) => entry.absolutePath) })
    } catch (error) {
      results.push({ ...record, state: 'manifest-unavailable', error: String(error?.message ?? error) })
    }
  }
  return results
}

async function readValidatedTransaction(id) {
  if (typeof id !== 'string' || !/^[0-9]{14}-[a-f0-9]{10}$/u.test(id)) throw new Error('invalid transaction id')
  const records = await readIndex()
  const record = [...records].reverse().find((entry) => entry.id === id)
  if (!record) throw new Error(`transaction not found: ${id}`)
  const manifestPath = validateLiteralAbsolute(record.manifestPath)
  const transactionRoot = path.dirname(manifestPath)
  const vault = path.dirname(transactionRoot)
  const defaultVault = path.join(safetyRoot(), 'recovery', 'trash')
  const localVault = /^\._?dsh-safekeep-[a-f0-9]{16}$/iu.test(path.basename(path.dirname(vault))) && path.basename(vault) === 'trash'
  if (path.basename(manifestPath) !== 'manifest.json' || path.basename(transactionRoot) !== id || (!comparePath(vault, defaultVault) && !localVault)) throw new Error('invalid recovery manifest location')
  await assertNoLinks(manifestPath)
  const manifest = JSON.parse(await fs.readFile(record.manifestPath, 'utf8'))
  if (manifest.id !== id || ![1, 2].includes(manifest.schema) || !Array.isArray(manifest.entries) || !manifest.entries.length) throw new Error('invalid recovery manifest')
  for (const entry of manifest.entries) {
    const original = validateLiteralAbsolute(entry.absolutePath)
    const stored = validateLiteralAbsolute(entry.storedPath)
    if (!comparePath(path.dirname(stored), transactionRoot) || !/^\d{3}-/u.test(path.basename(stored))) throw new Error('stored entry escapes its transaction directory')
    assertNotProtected(original, { allowSafetyTaskTemp: await isRegisteredTaskPath(original) })
    await assertNoLinks(original)
    await assertNoLinks(stored)
    if (manifest.schema === 2 && !entry.integrity && entry.moved) throw new Error('missing integrity record')
  }
  assertNoOverlap(manifest.entries)
  if (new Set(manifest.entries.map(e => e.storedPath.toLowerCase())).size !== manifest.entries.length) throw new Error('duplicate stored entry')
  return { record, manifest }
}

export async function verifyTransaction(id) {
  const { manifest, record } = await readValidatedTransaction(id)
  const entries = []
  for (const entry of manifest.entries) {
    const stored = await exists(entry.storedPath), original = await exists(entry.absolutePath)
    if (!stored && !original) throw new Error(`recovery item missing at both locations: ${entry.absolutePath}`)
    const actual = await verifyTree(stored ? entry.storedPath : entry.absolutePath, entry.integrity)
    if (!stored && manifest.state !== 'restored' && !entry.integrity) throw new Error('legacy transaction cannot prove an interrupted restore; inspect it manually')
    entries.push({ originalPath: entry.absolutePath, location: stored ? 'vault' : 'original', destinationOccupied: stored && original, verifiedAgainstOriginal: Boolean(entry.integrity), integrity: actual })
  }
  return { id, state: manifest.state, manifestPath: record.manifestPath, entries }
}

export async function restoreTransaction(id) {
  return withTrashLock(async () => {
  const { record, manifest } = await readValidatedTransaction(id)
  if (!['moved', 'moving', 'restoring', 'rollback-incomplete', 'restore-rollback-incomplete'].includes(manifest.state)) throw new Error(`transaction is not restorable from state ${manifest.state}`)
  const verified = await verifyTransaction(id)
  const conflict = verified.entries.find(e => e.destinationOccupied)
  if (conflict) throw new Error(`restore destination already exists: ${conflict.originalPath}`)
  // Upgrade old manifests with a current integrity baseline, without claiming
  // the baseline proves what their content was at the original move time.
  for (let i = 0; i < manifest.entries.length; i++) {
    const entry = manifest.entries[i]
    if (!entry.integrity) { entry.integrity = verified.entries[i].integrity; entry.integrityEstablishedAtRestore = true }
  }
  await writeManifest(record.manifestPath, { ...manifest, state: 'restoring' })
  for (const entry of manifest.entries) {
    if (await exists(entry.storedPath)) {
      await assertNoLinks(entry.absolutePath)
      if (await exists(entry.absolutePath)) throw new Error(`restore destination already exists: ${entry.absolutePath}`)
      await fs.rename(entry.storedPath, entry.absolutePath)
      await verifyTree(entry.absolutePath, entry.integrity)
    }
    entry.restored = true
    await writeManifest(record.manifestPath, { ...manifest, state: 'restoring' })
  }
  const finished = { ...manifest, state: 'restored', restoredAt: new Date().toISOString() }
  await writeManifest(record.manifestPath, finished)
  void recordAudit({ kind: 'safe-trash-restore', transactionId: id, manifestPath: record.manifestPath, targets: manifest.entries.map((entry) => entry.absolutePath) }).catch(() => {})
  return finished
  })
}
