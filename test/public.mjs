import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { safetyRoot, secureDirectory } from '../lib/storage.mjs'
import { createTaskTemp, retireTaskTemp } from '../lib/safe-temp.mjs'
import { resolveMutationPath } from '../lib/guard-core.mjs'
import { assertOutsideVault } from '../lib/paths.mjs'
import { analyzePowerShell } from '../lib/powershell.mjs'
import { snapshots, trash, doctor } from '../lib/operations.mjs'
const root = (await createTaskTemp('public-acceptance')).path
const checks = []
const check = async (name, fn) => { try { await fn(); checks.push({ name, passed: true }) } catch (e) { checks.push({ name, passed: false, error: e.stack }) } }
for (const target of ['C:', '\\\\server\\share\\file.txt', '//server/share/file.txt']) await check(`unsupported path ${target}`, () => assert.throws(() => resolveMutationPath(target, root)))
await check('module-qualified Out-File gets an exact snapshot target', async () => assert.deepEqual((await analyzePowerShell("'x' | Microsoft.PowerShell.Utility\\Out-File native.txt", root)).targets, [path.join(root, 'native.txt')]))
await check('private ACL remains valid across a fresh CLI process', async () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/dsh-safekeep.mjs', import.meta.url)), 'doctor'], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout).result
  assert.equal(parsed.privateStorageAcl, true); assert.equal(parsed.liveLoaded, null)
})
await check('storage will not take ownership of an unrelated nonempty directory', async () => {
  const dir = path.join(root, 'unrelated'); await fs.mkdir(dir); await fs.writeFile(path.join(dir, 'keep'), 'keep', { flag: 'wx' })
  await assert.rejects(() => secureDirectory(dir), /not owned/)
  assert.equal(await fs.readFile(path.join(dir, 'keep'), 'utf8'), 'keep')
})
await check('registered task retirement and recovery retain bytes', async () => {
  const task = await createTaskTemp('roundtrip'); await fs.writeFile(path.join(task.path, 'keep'), 'retire-bytes', { flag: 'wx' })
  const [tx] = await retireTaskTemp(task.path)
  await trash({ action: 'verify', id: tx.id }); await trash({ action: 'restore', id: tx.id })
  assert.equal(await fs.readFile(path.join(task.path, 'keep'), 'utf8'), 'retire-bytes')
})
await check('unregistered task retirement rejected', async () => {
  const dir = path.join(root, 'pretend-temp'); await fs.mkdir(dir)
  await assert.rejects(() => retireTaskTemp(dir), /direct/)
})
await check('no root or vault can be used as an overwrite target', () => {
  for (const file of [safetyRoot(), path.join(safetyRoot(), 'recovery', 'object'), 'D:\\.dsh-safekeep-0123456789abcdef\\trash\\item']) assert.throws(() => assertOutsideVault(file))
})
await check('strict public CLI rejects unknown or conflicting options', () => {
  const cli = fileURLToPath(new URL('../bin/dsh-safekeep.mjs', import.meta.url))
  for (const args of [['trash', 'move', root, '--force'], ['snapshots', '--limit', 'NaN'], ['snapshots', 'restore', 'bad', '--to', path.join(root, 'x'), '--in-place'], ['doctor', '--repair']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 1)
  }
})
await check('snapshot API rejects conflicting destination choices before work', () => assert.rejects(() => snapshots({ action: 'restore', id: 'bad', to: path.join(root, 'x'), in_place: true }), /either/))
await check('doctor distinguishes runtime history from loading', async () => { const report = await doctor(); assert.equal(report.liveLoaded, null); assert(report.privateStorageAcl) })
const report = { ok: checks.every(c => c.passed), passed: checks.filter(c => c.passed).length, failed: checks.filter(c => !c.passed).length, checks }
await fs.writeFile(path.join(root, 'acceptance.json'), JSON.stringify(report, null, 2), { flag: 'wx' })
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
process.exitCode = report.ok ? 0 : 1
