import { listSnapshots, inspectSnapshot, verifySnapshot, restoreSnapshot, readAudit } from './recovery.mjs'
import { moveTargets, listTransactions, verifyTransaction, restoreTransaction, validateLiteralAbsolute } from './safe-trash.mjs'
import { createTaskTemp, listTaskTemps, retireTaskTemp } from './safe-temp.mjs'
import { safetyRoot, ensureStorage } from './storage.mjs'
import { dshBuildInfo } from './dsh-safety.mjs'
import { promises as fs } from 'node:fs'

const limitOf = n => {
  if (n === undefined) return 30
  if (!Number.isSafeInteger(n) || n < 1 || n > 1000) throw new Error('limit must be an integer from 1 to 1000')
  return n
}
export async function snapshots(args = {}) {
  const action = args.action ?? 'list'
  if (args.to && args.in_place) throw new Error('choose either to or in_place')
  if (action === 'list') return listSnapshots({ file: args.path && validateLiteralAbsolute(args.path), limit: limitOf(args.limit) })
  if (action === 'inspect') return inspectSnapshot(args.id)
  if (action === 'verify') return verifySnapshot(args.id)
  if (action === 'restore') return restoreSnapshot(args.id, { to: args.to && validateLiteralAbsolute(args.to), inPlace: args.in_place === true })
  throw new Error('unknown snapshots action')
}
export async function trash(args = {}) {
  const action = args.action ?? 'list'
  if (action === 'list') return listTransactions(limitOf(args.limit))
  if (action === 'move') return moveTargets([validateLiteralAbsolute(args.path)])
  if (action === 'verify') return verifyTransaction(args.id)
  if (action === 'restore') return restoreTransaction(args.id)
  throw new Error('unknown trash action')
}
export async function temp(args = {}) {
  const action = args.action ?? 'list'
  if (action === 'list') return listTaskTemps(limitOf(args.limit))
  if (action === 'create') return createTaskTemp(args.label)
  if (action === 'retire') return retireTaskTemp(args.path)
  throw new Error('unknown temp action')
}
export async function doctor() {
  const storage = await ensureStorage()
  const stats = await fs.statfs(safetyRoot())
  const { events, warnings } = await readAudit()
  const build = dshBuildInfo()
  const recent = events.filter(e => e.host === 'dsh' && e.codeHash === build.codeHash && e.kind === 'guard-check').slice(-5).map(({ at, sessionId, tool, outcome }) => ({ at, sessionId, tool, outcome }))
  return { ...build, platform: process.platform, node: process.version, pwsh: storage.pwsh, storageRoot: safetyRoot(), privateStorageAcl: storage.private, availableBytes: stats.bavail * stats.bsize, recentMatchingChecks: recent, warnings, liveLoaded: null, next: 'In your current DSH session call data_safety_status and run the documented file canary. CLI/history alone does not prove current loading.' }
}
