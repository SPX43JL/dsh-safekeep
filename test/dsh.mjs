import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createTaskTemp } from '../lib/safe-temp.mjs'
import { listSnapshots, restoreSnapshot, verifySnapshot } from '../lib/recovery.mjs'
import { analyzeDshExecution } from '../lib/dsh-safety.mjs'
import * as safety from '../dsh-plugin.mjs'
const moduleAt = name => import(`@deepseek-ai/${name}`)
const { Context } = await moduleAt('cordis')
const { default: SystemPrompt } = await moduleAt('dsh-system-prompt')
const { default: ToolRuntime, defineTool } = await moduleAt('dsh-tools')
const { default: FsLocal } = await moduleAt('dsh-fs-local')
const FsTools = await moduleAt('dsh-tool-fs')
const Observation = await moduleAt('dsh-fs-observation-policy')
const run = await createTaskTemp('dsh-acceptance')
const root = run.path, checks = []
const check = async (name, fn) => { const start = performance.now(); try { await fn(); checks.push({ name, passed: true, ms: Math.round(performance.now() - start) }) } catch (error) { checks.push({ name, passed: false, error: error.stack }) } }
async function context({ skipPreflight = false, mutateDuringPreflight = false } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FsLocal, { cwd: root })
  await ctx.plugin(Observation)
  await ctx.plugin(FsTools)
  if (skipPreflight) ctx.on('tools/pre-execute', () => ({ kind: 'allow' }))
  if (mutateDuringPreflight) ctx.on('tools/pre-execute', (execution, next) => {
    const pending = next()
    const timer = setTimeout(() => { execution.arguments = { ...execution.arguments, command: 'Set-Content alternate.txt after' } }, 50)
    return Promise.resolve(pending).finally(() => clearTimeout(timer))
  })
  await ctx.plugin(safety)
  let bodies = 0
  ctx.tools.register(defineTool({ name: 'pwsh', description: 'Inert shell for component tests', parameters: { command: { type: 'string', required: true }, workdir: { type: 'string' } }, output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] }, execute() { bodies++; return 'inert-shell-body' } }))
  const agent = { session: { id: 'dsh-component-test', header: { cwd: root } } }
  return { ctx, bodies: () => bodies, call: (name, args) => ctx.tools.execute({ name, arguments: args, agent, callId: `component-${checks.length}`, signal: new AbortController().signal }) }
}
const fixture = await context()
await fs.writeFile(path.join(root, 'native.txt'), 'native-before\n', { flag: 'wx' })
for (const [name, args] of [['read', { file_path: 'native.txt' }], ['edit', { file_path: 'native.txt', old_string: 'native-before', new_string: 'native-edited' }], ['write', { file_path: 'native.txt', content: 'native-written\n' }]]) {
  await check(`real native ${name} succeeds with observation policy`, async () => { const result = await fixture.call(name, args); assert(!result.isError, JSON.stringify(result)) })
}
await check('native edit/write saved both previous contents at session cwd', async () => {
  const saved = (await listSnapshots({ file: path.join(root, 'native.txt') })).snapshots
  const contents = await Promise.all(saved.map(e => fs.readFile(e.snapshotPath, 'utf8')))
  assert(contents.includes('native-before\n')); assert(contents.includes('native-edited\n'))
  const first = saved.find(e => e.tool === 'edit')
  await verifySnapshot(first.id)
  const restored = await restoreSnapshot(first.id)
  assert.equal(await fs.readFile(restored.destination, 'utf8'), 'native-before\n')
})
await check('unread existing file remains protected by official observation policy', async () => {
  await fs.writeFile(path.join(root, 'unread.txt'), 'keep-unread', { flag: 'wx' })
  assert((await fixture.call('write', { file_path: 'unread.txt', content: 'unexpected' })).isError)
  assert.equal(await fs.readFile(path.join(root, 'unread.txt'), 'utf8'), 'keep-unread')
})
await check('new native file needs no approval', async () => { assert(!(await fixture.call('write', { file_path: 'new.txt', content: 'new-content' })).isError) })
await fs.mkdir(path.join(root, 'nested'))
await fs.writeFile(path.join(root, 'nested', 'shell.txt'), 'workdir-before', { flag: 'wx' })
await check('pwsh workdir targets correct existing file', async () => {
  assert(!(await fixture.call('pwsh', { command: 'Set-Content shell.txt after', workdir: 'nested' })).isError)
  const snapshots = (await listSnapshots({ file: path.join(root, 'nested', 'shell.txt') })).snapshots
  assert(snapshots.some(e => e.host === 'dsh' && e.tool === 'pwsh'))
})
for (const command of ['git status --short', 'npm install --package-lock-only --ignore-scripts', 'npm test', 'Get-Command node 2>$null', 'Write-Output ok > $null', 'Remove-Item example.txt -WhatIf', 'git clean -ndx', 'git restore --staged example.txt', "$p='nested/shell.txt'; Set-Content $p after"]) {
  await check(`normal: ${command}`, async () => { assert(!(await fixture.call('pwsh', { command })).isError) })
}
for (const command of ['  ri example.txt', 'git clean -fdx', 'git reset --hard', 'Remove-Item example.txt -WhatIf:$false', 'Remove-Item example.txt -WhatIf; Remove-Item second.txt', 'Set-Content $unknown value', 'Set-Content C:\\nul.txt value']) {
  await check(`danger/unknown: ${command}`, async () => { const before = fixture.bodies(); assert((await fixture.call('pwsh', { command })).isError); assert.equal(fixture.bodies(), before) })
}
await check('Bash does not receive PowerShell variable semantics', async () => {
  const result = await analyzeDshExecution({ name: 'bash', arguments: { command: 'echo ok' } })
  assert.equal(result.analysis, 'shell-text')
})
await check('live status includes loaded fingerprint and real check counters', async () => {
  const result = await fixture.call('data_safety_status', {})
  assert(!result.isError)
  const status = JSON.parse(result.content[0].text)
  assert(status.loaded && status.instance.snapshots >= 3 && status.currentSession.blocked >= 7)
  assert.match(status.codeHash, /^[a-f0-9]{64}$/u)
})
const skipped = await context({ skipPreflight: true })
await check('monotonic guard catches middleware skipping preflight', async () => {
  assert((await skipped.call('pwsh', { command: 'Write-Output ok' })).isError)
  assert.equal(skipped.bodies(), 0)
})
await check('native recovery never widens absent/read-only/workspace permissions', async () => {
  fixture.ctx.provide('sandboxPolicy', { resolve: () => undefined })
  for (const mode of [undefined, 'read-only', 'workspace-write']) {
    if (mode) fixture.ctx.set('sandboxPolicy', { resolve: () => ({ mode }) })
    const result = await fixture.call('data_safety_temp', { action: 'create', label: 'must-not-run' })
    assert(result.isError, JSON.stringify(result)); assert.match(JSON.stringify(result), /does not widen permissions/u)
  }
})
await check('native recovery tool works under explicit full access', async () => {
  fixture.ctx.set('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access' }) })
  const result = await fixture.call('data_safety_temp', { action: 'create', label: 'native-recovery' })
  assert(!result.isError, JSON.stringify(result))
  const owned = JSON.parse(result.content[0].text)
  const retired = await fixture.call('data_safety_temp', { action: 'retire', path: owned.path })
  assert(!retired.isError, JSON.stringify(retired))
  const [tx] = JSON.parse(retired.content[0].text)
  assert(!(await fixture.call('data_safety_trash', { action: 'restore', id: tx.id })).isError)
  assert(await fs.stat(owned.path))
})
await check('changed arguments during asynchronous analysis are rejected', async () => {
  const mutated = await context({ mutateDuringPreflight: true })
  const result = await mutated.call('pwsh', { command: 'Set-Content native.txt after' })
  assert(result.isError, JSON.stringify(result)); assert.equal(mutated.bodies(), 0)
})
await check('snapshot audit carries call identity and current code fingerprint', async () => {
  const saved = (await listSnapshots({ file: path.join(root, 'native.txt') })).snapshots
  assert(saved.some(s => s.callId && /^[a-f0-9]{64}$/u.test(s.codeHash)))
})
const report = { ok: checks.every(c => c.passed), runDirectory: root, hostVersion: '0.1.5-rc.2', safetyVersion: '0.1.0-rc.1', passed: checks.filter(c => c.passed).length, failed: checks.filter(c => !c.passed).length, checks, evidenceLevel: 'real installed ToolRuntime and native filesystem/observation plugins, inert shell bodies; Web/headless model sessions are separate' }
await fs.writeFile(path.join(root, 'acceptance.json'), JSON.stringify(report, null, 2), { flag: 'wx' })
process.stdout.write(JSON.stringify(report, null, 2))
process.exitCode = report.ok ? 0 : 1
