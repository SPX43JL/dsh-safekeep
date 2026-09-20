import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveMutationPath } from './guard-core.mjs'
import { assertNoLinks, assertOutsideVault, inside, samePath, writeExclusive } from './paths.mjs'
import { safetyRoot, ensureStorage } from './storage.mjs'

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024

function safeName(value) {
  return value.replace(/[^A-Za-z0-9._-]+/gu, '_').slice(0, 120) || 'file'
}

function dayStamp(date = new Date()) {
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}

async function appendJsonLine(filePath, value) {
  await ensureStorage()
  await assertNoLinks(filePath)
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export async function recordAudit(event) {
  const entry = {
    at: new Date().toISOString(),
    id: randomUUID(),
    ...event,
  }
  await appendJsonLine(path.join(safetyRoot(), 'logs', 'guard-events.jsonl'), entry)
  return entry
}

export async function snapshotExistingPath(rawPath, options = {}) {
  const absolutePath = resolveMutationPath(rawPath, options.cwd)
  assertOutsideVault(absolutePath)
  await assertNoLinks(absolutePath)
  let stat
  try {
    stat = await fs.lstat(absolutePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'absent', path: absolutePath }
    throw error
  }

  if (stat.isSymbolicLink()) {
    const linkTarget = await fs.readlink(absolutePath)
    throw new Error(`refusing to overwrite symbolic link ${absolutePath} -> ${linkTarget}; resolve and verify the intended target first`)
  }
  if (!stat.isFile()) return { status: 'not-file', path: absolutePath }
  if (stat.nlink > 1) throw new Error(`existing file has multiple hard links; use a versioned output: ${absolutePath}`)
  if (stat.size > MAX_SNAPSHOT_BYTES) {
    throw new Error(`existing file is ${stat.size} bytes, above the ${MAX_SNAPSHOT_BYTES}-byte automatic snapshot cap; write a versioned output instead`)
  }

  const handle = await fs.open(absolutePath, 'r')
  let bytes
  let before
  let after
  try {
    before = await handle.stat()
    if (before.size > MAX_SNAPSHOT_BYTES) {
      throw new Error(`existing file is ${before.size} bytes, above the ${MAX_SNAPSHOT_BYTES}-byte automatic snapshot cap; write a versioned output instead`)
    }
    bytes = await handle.readFile()
    after = await handle.stat()
  } finally {
    await handle.close()
  }
  if (before.dev !== stat.dev || before.ino !== stat.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) {
    throw new Error(`existing file changed while its recovery snapshot was being read: ${absolutePath}`)
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  const snapshotDir = path.join(safetyRoot(), 'recovery', 'snapshots', dayStamp())
  await ensureStorage()
  const snapshotPath = path.join(snapshotDir, `${digest}-${safeName(path.basename(absolutePath))}`)
  await assertNoLinks(snapshotDir)
  await fs.mkdir(snapshotDir, { recursive: true, mode: 0o700 })
  try {
    await writeExclusive(snapshotPath, bytes)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    await assertNoLinks(snapshotPath)
    const stored = await fs.readFile(snapshotPath)
    if (stored.length !== bytes.length || createHash('sha256').update(stored).digest('hex') !== digest) throw new Error(`existing recovery object failed integrity verification: ${snapshotPath}`)
  }

  const event = await recordAudit({
    kind: 'snapshot',
    host: options.host ?? 'unknown',
    sessionId: options.sessionId ?? null,
    callId: options.callId ?? null,
    codeHash: options.codeHash ?? null,
    tool: options.tool ?? null,
    originalPath: absolutePath,
    snapshotPath,
    sha256: digest,
    bytes: bytes.length,
    modifiedAt: after.mtime.toISOString(),
  })
  return { status: 'snapshotted', path: absolutePath, snapshotPath, digest, eventId: event.id }
}

export async function readAudit() {
  const auditPath = path.join(safetyRoot(), 'logs', 'guard-events.jsonl')
  await assertNoLinks(auditPath)
  let text
  try { text = await fs.readFile(auditPath, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return { events: [], warnings: [] }
    throw error
  }
  const events = [], warnings = []
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { warnings.push(`unreadable audit line ${index + 1}`) }
  }
  return { events, warnings }
}

export async function listSnapshots({ file, limit = 30 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('snapshot limit must be an integer from 1 to 10000')
  const { events, warnings } = await readAudit()
  const matches = events.filter(e => e.kind === 'snapshot' && (!file || samePath(file, e.originalPath)))
  return { snapshots: matches.slice(-Math.min(10000, Math.max(1, limit))).reverse(), warnings }
}

export async function inspectSnapshot(id) {
  if (!/^[a-f0-9-]{36}$/u.test(id ?? '')) throw new Error('expected a full snapshot event UUID (use dsh-safekeep snapshots)')
  const { events } = await readAudit()
  const event = events.find(e => e.kind === 'snapshot' && e.id === id)
  if (!event) throw new Error(`snapshot not found: ${id}`)
  const root = path.join(safetyRoot(), 'recovery', 'snapshots')
  if (!path.isAbsolute(event.snapshotPath) || !inside(event.snapshotPath, root) || !/^[a-f0-9]{64}$/u.test(event.sha256) || !Number.isSafeInteger(event.bytes) || event.bytes < 0 || event.bytes > MAX_SNAPSHOT_BYTES) throw new Error('invalid snapshot metadata')
  await assertNoLinks(event.snapshotPath)
  return event
}

export async function verifySnapshot(id) {
  const event = await inspectSnapshot(id)
  const data = await fs.readFile(event.snapshotPath)
  const actual = createHash('sha256').update(data).digest('hex')
  if (data.length !== event.bytes || actual !== event.sha256) throw new Error(`snapshot integrity mismatch: ${id}`)
  return { ...event, verified: true }
}

export async function restoreSnapshot(id, { to, inPlace = false } = {}) {
  if (to && inPlace) throw new Error('use either --to or --in-place')
  const event = await verifySnapshot(id)
  const bytes = await fs.readFile(event.snapshotPath)
  if (createHash('sha256').update(bytes).digest('hex') !== event.sha256) throw new Error('snapshot changed during restore')
  const destination = resolveMutationPath(to ?? (inPlace ? event.originalPath : `${event.originalPath}.recovered-${id.slice(0, 8)}`), process.cwd())
  assertOutsideVault(destination)
  await assertNoLinks(destination)
  let preserved = null
  if (inPlace) {
    const current = await snapshotExistingPath(destination, { host: 'recovery', tool: 'restore', cwd: process.cwd() })
    if (current.status === 'not-file') throw new Error('restore destination is not a regular file')
    if (current.status === 'snapshotted') {
      const currentBytes = await fs.readFile(destination)
      if (createHash('sha256').update(currentBytes).digest('hex') !== current.digest) throw new Error('current file changed before restore; retry after writes finish')
      preserved = `${destination}.before-restore-${randomUUID()}`
      // Preserve the current directory entry, then exclusively create the restored
      // file. A competing new file is never overwritten. Recovery copies survive
      // even if the process stops between these operations.
      await recordAudit({ kind: 'snapshot-restore-planned', snapshotId: id, destination, preserved, currentSnapshotId: current.eventId })
      await fs.rename(destination, preserved)
    }
  }
  try { await writeExclusive(destination, bytes) } catch (error) {
    throw new Error(`restore did not complete: ${error.message}${preserved ? `; previous file retained at ${preserved}` : ''}`)
  }
  const digest = createHash('sha256').update(await fs.readFile(destination)).digest('hex')
  if (digest !== event.sha256) throw new Error(`restored file verification failed; recovery source retained: ${destination}`)
  await recordAudit({ kind: 'snapshot-restored', snapshotId: id, destination, preserved, sha256: digest })
  return { restored: true, destination, preserved, sha256: digest }
}

export async function snapshotTargets(targets, options = {}) {
  const unique = [...new Set(targets)]
  const results = []
  for (const target of unique) results.push(await snapshotExistingPath(target, options))
  return results
}

export function denyDecision(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}
