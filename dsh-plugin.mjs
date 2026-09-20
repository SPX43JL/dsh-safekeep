import { recordAudit, snapshotTargets } from './lib/recovery.mjs'
import { analyzeDshExecution, denialReason, dshBuildInfo, executionSignature, needsPreflight } from './lib/dsh-safety.mjs'
import { snapshots, trash, temp } from './lib/operations.mjs'
import { ensureStorage, safetyRoot } from './lib/storage.mjs'

export const name = 'dsh-safekeep'
export const inject = ['tools']

export function apply(ctx) {
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) !== 24) throw new Error('DSH Safekeep requires Windows and Node 24; see the tested compatibility matrix')
  if (typeof ctx.tools?.guard !== 'function' || typeof ctx.tools?.register !== 'function') throw new Error('DSH tools.guard/register API unavailable; supported host: 0.1.5-rc.2')
  // Register guards synchronously. Cordis plugin() is not an awaitable ready
  // barrier for asynchronous apply; early tool calls must also be checked.
  const storageReady = ensureStorage().then(() => ({ ok: true }), error => ({ ok: false, error: error.message }))
  const build = dshBuildInfo()
  const receipts = new WeakMap()
  const state = { checks: 0, blocked: 0, snapshots: 0, lastCheck: null }
  const sessions = new Map()
  const sessionState = execution => {
    const id = execution.agent?.session?.id ?? null
    if (!sessions.has(id)) {
      if (sessions.size >= 100) sessions.delete(sessions.keys().next().value)
      sessions.set(id, { checks: 0, blocked: 0, snapshots: 0 })
    }
    return sessions.get(id)
  }
  const common = execution => ({ host: 'dsh', ...build, sessionId: execution.agent?.session?.id ?? null, tool: execution.name, callId: execution.callId ?? null })
  const blocked = async (execution, reason, code) => {
    state.blocked++
    sessionState(execution).blocked++
    await recordAudit({ kind: 'blocked', ...common(execution), reason, code }).catch(() => {})
    return { kind: 'deny', reason }
  }
  // A later permissive middleware cannot skip a required snapshot. The receipt
  // also detects changed arguments between asynchronous preflight and dispatch.
  ctx.tools.guard(execution => {
    try {
      if (!needsPreflight(execution)) return undefined
      if (receipts.get(execution) === executionSignature(execution)) return undefined
      const reason = 'AI data-safety guard: required preflight was skipped or tool arguments changed; no file operation ran. Check plugin composition.'
      void blocked(execution, reason, 'DSH_PREFLIGHT_MISSING')
      return reason
    } catch (error) {
      const reason = `AI data-safety guard could not validate the final tool path: ${error.message}`
      void blocked(execution, reason, 'DSH_GUARD_FAILURE')
      return reason
    }
  })

  ctx.on('tools/pre-execute', async (execution, next) => {
    if (execution.name === 'data_safety_status') return next()
    const started = performance.now()
    try {
      const storage = await storageReady
      if (!storage.ok) throw new Error(storage.error)
      const signature = executionSignature(execution)
      const result = await analyzeDshExecution(execution)
      if (result.risk.blocked) return blocked(execution, denialReason(result.risk), result.risk.code)
      const snapshots = await snapshotTargets(result.targets, { ...common(execution), cwd: result.cwd })
      if (executionSignature(execution) !== signature) throw new Error('tool arguments changed during preflight')
      receipts.set(execution, signature)
      const count = snapshots.filter(item => item.status === 'snapshotted').length
      const event = { kind: 'guard-check', ...common(execution), analysis: result.analysis, snapshotCount: count, durationMs: Math.round(performance.now() - started), outcome: 'checked' }
      await recordAudit(event)
      state.checks++; state.snapshots += count
      const current = sessionState(execution)
      current.checks++; current.snapshots += count
      state.lastCheck = { at: new Date().toISOString(), tool: execution.name, sessionId: event.sessionId, durationMs: event.durationMs }
    } catch (error) {
      return blocked(execution, `AI data-safety guard could not preserve the file before mutation: ${error.message}`, 'DSH_GUARD_FAILURE')
    }
    return next()
  })

  // Registry-ready public ToolDefinition; no private Cordis or loader APIs.
  ctx.tools.register({
    name: 'data_safety_status',
    description: 'Read the loaded DSH Safekeep version, fingerprint and current-session counters. Loading alone is not proof that a write was protected; use the documented canary.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    async execute(_args, execution) {
      return JSON.stringify({ loaded: true, storage: await storageReady, ...build, instance: state, currentSessionId: execution?.agent?.session?.id ?? null, currentSession: sessionState(execution ?? {}), storageRoot: safetyRoot(), testedDshVersion: '0.1.5-rc.2', hostVersionDetection: 'capability check only; verify dsh --version separately', automaticSnapshotCapMiB: 64, coverage: ['native write/edit and explicit str_replace_editor mutations', 'pwsh recognized literal paths with workdir; nested native dispatch'], unobserved: ['arbitrary script internals or direct PTC filesystem APIs', 'interactive input and persistent-shell cwd changes', 'MCP/browser/Office writes and remote filesystems'] }, null, 2)
    },
  })
  const str = description => ({ type: 'string', description })
  for (const [tool, fn, description, actions, properties] of [
    ['data_safety_snapshots', snapshots, 'List, inspect, verify or restore file snapshots. Restore creates a new sibling by default; in_place preserves the current version first.', ['list', 'inspect', 'verify', 'restore'], { id: str('Full snapshot UUID'), path: str('Absolute original file path for list'), to: str('New absolute restore destination, must not exist'), in_place: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 1000 } }],
    ['data_safety_trash', trash, 'Recoverable removal for user-requested deletion. Resolve and verify the exact absolute path first. No wildcard or purge. verify/restore use the full transaction ID.', ['list', 'move', 'verify', 'restore'], { id: str('Full transaction ID'), path: str('Verified absolute path for move'), limit: { type: 'integer', minimum: 1, maximum: 1000 } }],
    ['data_safety_temp', temp, 'Create a registered task directory. Retire only a registered direct child through recoverable trash; never use an existing user directory as temporary.', ['create', 'list', 'retire'], { path: str('Absolute owned task directory for retire'), label: str('Short label for create'), limit: { type: 'integer', minimum: 1, maximum: 1000 } }],
  ]) ctx.tools.register({ name: tool, description, parameters: { type: 'object', properties: { action: { type: 'string', enum: actions }, ...properties }, required: ['action'], additionalProperties: false }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, isConcurrencySafe: () => false, async execute(args, execution) {
    if (['move', 'restore', 'create', 'retire'].includes(args.action)) {
      const policy = ctx.get('sandboxPolicy')?.resolve({ session: execution.agent?.session })
      if (policy?.mode !== 'danger-full-access') throw new Error('Native recovery mutations require the current DSH danger-full-access policy. This tool does not widen permissions. An operator can use the offline CLI outside the session.')
    }
    return JSON.stringify(await fn(args), null, 2)
  } })
}
