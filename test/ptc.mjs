// Real installed PTC worker/ToolRuntime, native filesystem tools; inert shell.
// This is a component integration check, not a Web/model PTC session.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createTaskTemp } from '../lib/safe-temp.mjs'
import { readAudit, listSnapshots, verifySnapshot } from '../lib/recovery.mjs'
import * as safety from '../dsh-plugin.mjs'

const moduleAt = name => import(`@deepseek-ai/${name}`)
const { Context } = await moduleAt('cordis')
const { default: SystemPrompt } = await moduleAt('dsh-system-prompt')
const { default: ToolRuntime, defineTool } = await moduleAt('dsh-tools')
const { default: CodeRuntime } = await moduleAt('dsh-code-runtime-worker-thread')
const { default: FsLocal } = await moduleAt('dsh-fs-local')
const FsTools = await moduleAt('dsh-tool-fs')
const Observation = await moduleAt('dsh-fs-observation-policy')
const run = await createTaskTemp('dsh-ptc-acceptance'), checks = []
const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime, { mode: 'both' })
await ctx.plugin(CodeRuntime)
await ctx.plugin(FsLocal, { cwd: run.path })
await ctx.plugin(Observation)
await ctx.plugin(FsTools)
await ctx.plugin(safety)
let shellBodies = 0
ctx.tools.register(defineTool({ name: 'pwsh', description: 'Inert shell for component acceptance', parameters: { command: { type: 'string', required: true } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute() { shellBodies++; return 'inert-shell' } }))
const dispatchLog = []
const agent = { session: { id: `dsh-ptc-${run.id}`, header: { cwd: run.path }, append: (kind, data) => dispatchLog.push({ kind, name: data.name, callId: data.subCallId, isError: data.isError }) } }
const check = async (name, fn) => { try { await fn(); checks.push({ name, passed: true }) } catch (error) { checks.push({ name, passed: false, error: error.message }) } }
let callNumber = 0
const call = code => ctx.tools.execute({ name: 'run_code', arguments: { code, description: 'Bounded local PTC acceptance' }, agent, callId: `ptc-acceptance-${++callNumber}`, signal: new AbortController().signal })
await fs.writeFile(path.join(run.path, 'native.txt'), 'ptc-before\n', { flag: 'wx' })
await check('real PTC worker dispatches native read/edit/write with snapshots', async () => {
  const result = await call(`await tools.read({file_path:'native.txt'}); await tools.edit({file_path:'native.txt',old_string:'ptc-before',new_string:'ptc-edited'}); return await tools.write({file_path:'native.txt',content:'ptc-written\\n'});`)
  assert(!result.isError, JSON.stringify(result))
  assert.equal(await fs.readFile(path.join(run.path, 'native.txt'), 'utf8'), 'ptc-written\n')
  const saved = (await listSnapshots({ file: path.join(run.path, 'native.txt') })).snapshots
  const contents = []
  for (const item of saved) { await verifySnapshot(item.id); contents.push(await fs.readFile(item.snapshotPath, 'utf8')) }
  assert(contents.includes('ptc-before\n') && contents.includes('ptc-edited\n'))
})
await check('nested PTC denial precedes shell body, then normal call still succeeds', async () => {
  const denied = await call(`return await tools.pwsh({command:'ri never-created-negative-canary.txt'});`)
  assert(denied.isError)
  assert.match(JSON.stringify(denied), /POWERSHELL_DELETE/u)
  assert.equal(shellBodies, 0)
  const allowed = await call(`return await tools.pwsh({command:'git status --short'});`)
  assert(!allowed.isError, JSON.stringify(allowed))
  assert.equal(shellBodies, 1)
})
await check('nested native calls retain session and distinct dispatch audit identity', async () => {
  const { events } = await readAudit()
  const audit = events.filter(e => e.sessionId === agent.session.id && e.callId?.includes(':ptc:'))
  assert(audit.some(e => e.kind === 'blocked' && e.code === 'POWERSHELL_DELETE'))
  assert(audit.some(e => e.tool === 'write' && e.snapshotCount === 1))
  assert(dispatchLog.some(e => e.kind === 'tool/ptc-dispatch' && e.name === 'write' && !e.isError))
})
const report = { ok: checks.every(c => c.passed), hostVersion: '0.1.5-rc.2', runDirectory: run.path, checks, dispatchLog, evidenceLevel: 'Real installed PTC worker and ToolRuntime with native filesystem/observation plugins; inert shell and synthetic session; no model or Web PTC claim' }
await fs.writeFile(path.join(run.path, 'acceptance.json'), JSON.stringify(report, null, 2), { flag: 'wx' })
process.stdout.write(JSON.stringify(report, null, 2))
process.exitCode = report.ok ? 0 : 1
