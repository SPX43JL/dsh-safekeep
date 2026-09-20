import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createTaskTemp } from '../lib/safe-temp.mjs'
import { classifyCommand, mutationTargetsForTool, resolveMutationPath } from '../lib/guard-core.mjs'
import { analyzePowerShell as analyzeCodexShell } from '../lib/powershell.mjs'
import { snapshotExistingPath, verifySnapshot, restoreSnapshot, listSnapshots } from '../lib/recovery.mjs'
import { moveTargets, restoreTransaction, verifyTransaction, validateLiteralAbsolute } from '../lib/safe-trash.mjs'
import { withTrashLock } from '../lib/transactions.mjs'

const run = await createTaskTemp('recovery-acceptance')
const root = run.path
const checks = [], failures = []
async function check(name, fn) {
  const at = performance.now()
  try { await fn(); checks.push({ name, passed: true, ms: Math.round(performance.now() - at) }) }
  catch (error) { const result = { name, passed: false, error: error.stack }; checks.push(result); failures.push(result) }
}
const write = (file, content) => fs.writeFile(file, content, { flag: 'wx' })
const ordinary = [
  'git status --short', 'git diff --stat', 'npm install --package-lock-only --ignore-scripts', 'npm test',
  'Get-Command node 2>$null', 'Write-Output ok > $null', 'Get-ChildItem | Out-File -FilePath listing.txt',
  'git clean -ndx', 'git restore --staged example.txt', 'Remove-Item -LiteralPath example.txt -WhatIf',
  'Clear-Content example.txt -WhatIf', 'robocopy source destination /MIR /L', 'conda clean --all --dry-run',
  'rg -n "Remove-Item|Set-Content -LiteralPath $out" README.md',
  'Write-Output "Set-Content -LiteralPath $out -Value test"',
]
for (const command of ordinary) await check(`normal: ${command}`, async () => { const result = await analyzeCodexShell(command, root); assert.equal(result.risk.blocked, false); for (const target of result.targets) resolveMutationPath(target, root) })

const dangerous = [
  '  Remove-Item C:\\example.txt', '\t ri -LiteralPath C:\\example.txt', 'git clean -fdx', 'git reset --hard HEAD', 'git restore example.txt',
  'Remove-Item x -WhatIf:$false', 'Remove-Item x -WhatIf; Remove-Item y', 'Remove-Item "C:\\x -WhatIf y"',
  'git clean -ndx; git reset --hard', 'robocopy a b /MIR /L; robocopy c d /MIR',
  "Write-Output 'C:\\trailing\\'; Remove-Item x", 'git clean -f -- "-n"', 'git clean -f "x -n y"',
  'node -e "require(\'node:fs\').rmSync(\'x\')"', 'sqlite3 x.db "DROP TABLE x;"',
]
for (const command of dangerous) await check(`danger: ${command}`, async () => { assert.equal((await analyzeCodexShell(command, root)).risk.blocked, true) })

await check('Add / Update / Move destination all included', async () => {
  assert.deepEqual(mutationTargetsForTool('apply_patch', { command: '*** Add File: a\n*** Update File: b\n*** Move to: c' }), ['a', 'b', 'c'])
})
for (const command of ['Set-Content target.txt value', '"x" | Out-File target.txt', '"x" > target.txt', 'Set-Content -LiteralPath target.txt -Value value', "$target='target.txt'; Set-Content -LiteralPath $target -Value value"]) {
  await check(`target: ${command}`, async () => { assert.deepEqual((await analyzeCodexShell(command, root)).targets, [path.join(root, 'target.txt')]) })
}
await check('multiple literal paths captured', async () => { assert.deepEqual((await analyzeCodexShell("Set-Content -LiteralPath 'a.txt','b.txt' -Value x", root)).targets, [path.join(root, 'a.txt'), path.join(root, 'b.txt')]) })
await check('unknown variable rejected', () => assert.rejects(() => analyzeCodexShell('Set-Content $unknown x', root), /cannot be resolved/))
await check('conditional assignment not inferred', () => assert.rejects(() => analyzeCodexShell("if ($flag) { $p='a.txt' }; Set-Content $p x", root), /cannot be resolved/))
await check('changed directory resolved', async () => { assert.deepEqual((await analyzeCodexShell('Set-Location nested; Set-Content target.txt x', root)).targets, [path.join(root, 'nested', 'target.txt')]) })
await check('unknown directory change rejected', () => assert.rejects(() => analyzeCodexShell('Set-Location $somewhere; Set-Content target.txt x', root), /directory change/))
await check('copy file into existing directory protects final filename', async () => {
  await write(path.join(root, 'copy-source.txt'), 'copy-source')
  await fs.mkdir(path.join(root, 'copy-destination'))
  assert.deepEqual((await analyzeCodexShell('Copy-Item copy-source.txt -Destination copy-destination', root)).targets, [path.join(root, 'copy-destination', 'copy-source.txt')])
})

const source = path.join(root, 'unicode-中文.txt'), before = `before-${randomUUID()}\n中文\r\n`
await write(source, before)
const snapshot = await snapshotExistingPath(source, { host: 'test', cwd: root })
await check('snapshot content/hash readable through CLI API', async () => { assert.equal((await verifySnapshot(snapshot.eventId)).verified, true); assert.equal(await fs.readFile(snapshot.snapshotPath, 'utf8'), before) })
await fs.writeFile(source, 'current-version')
await check('restore defaults to a new file and preserves current', async () => { const result = await restoreSnapshot(snapshot.eventId); assert.equal(await fs.readFile(result.destination, 'utf8'), before); assert.equal(await fs.readFile(source, 'utf8'), 'current-version') })
await check('existing restore destination refused', () => assert.rejects(() => restoreSnapshot(snapshot.eventId), /EEXIST/))
await check('in-place restore preserves current version', async () => { const result = await restoreSnapshot(snapshot.eventId, { inPlace: true }); assert.equal(await fs.readFile(source, 'utf8'), before); assert.equal(await fs.readFile(result.preserved, 'utf8'), 'current-version') })
await check('history list filters original path', async () => { const result = await listSnapshots({ file: source }); assert(result.snapshots.some(e => e.id === snapshot.eventId)); assert(result.snapshots.every(e => e.originalPath === source)) })
await check('corrupt snapshot is refused, then original object reinstated', async () => {
  const original = await fs.readFile(snapshot.snapshotPath)
  await write(path.join(root, 'snapshot-original-for-integrity-test'), original)
  try { await fs.writeFile(snapshot.snapshotPath, 'damaged-test-copy'); await assert.rejects(() => verifySnapshot(snapshot.eventId), /integrity mismatch/); await assert.rejects(() => snapshotExistingPath(source, { cwd: root }), /integrity verification/) }
  finally { await fs.writeFile(snapshot.snapshotPath, original) }
  await verifySnapshot(snapshot.eventId)
})
await check('parent junction rejected including nonexistent leaf', async () => {
  const target = path.join(root, 'real-directory'), link = path.join(root, 'junction')
  await fs.mkdir(target); await write(path.join(target, 'file.txt'), 'value'); await fs.symlink(target, link, 'junction')
  await assert.rejects(() => snapshotExistingPath(path.join(link, 'file.txt'), { cwd: root }), /junction/)
  await assert.rejects(() => snapshotExistingPath(path.join(link, 'new.txt'), { cwd: root }), /junction/)
  await assert.rejects(() => moveTargets([path.join(link, 'file.txt')]), /junction/)
})
await check('hard-linked existing file rejected', async () => { const second = path.join(root, 'hard-link.txt'); await fs.link(source, second); await assert.rejects(() => snapshotExistingPath(second), /hard links/) })
for (const bad of ['C:relative.txt', '\\ambiguous.txt', '\\\\?\\C:\\x', 'C:\\a.txt:stream', 'C:\\x\\..\\y', 'C:\\nul.txt', 'C:\\x.\\y']) {
  await check(`invalid path: ${bad}`, () => { assert.throws(() => resolveMutationPath(bad, root)); assert.throws(() => validateLiteralAbsolute(bad)) })
}
await check('automatic cap rejects a newly generated 65 MiB target', async () => { const big = path.join(root, 'large-fixture.bin'); await write(big, Buffer.alloc(65 * 1024 * 1024, 71)); await assert.rejects(() => snapshotExistingPath(big), /snapshot cap/) })

await check('trash tree checks bytes, verifies and restores', async () => {
  const directory = path.join(root, 'tree'); await fs.mkdir(directory); await write(path.join(directory, 'file.txt'), 'tree-bytes'); await fs.mkdir(path.join(directory, 'empty'))
  const [transaction] = await moveTargets([directory]); const verified = await verifyTransaction(transaction.id)
  assert.equal(verified.entries[0].verifiedAgainstOriginal, true); await restoreTransaction(transaction.id); assert.equal(await fs.readFile(path.join(directory, 'file.txt'), 'utf8'), 'tree-bytes')
})
await check('trash conflict preserves both versions', async () => {
  const file = path.join(root, 'conflict.txt'); await write(file, 'old'); const [transaction] = await moveTargets([file]); await write(file, 'new')
  await assert.rejects(() => restoreTransaction(transaction.id), /already exists/); assert.equal(await fs.readFile(file, 'utf8'), 'new')
  const [current] = await moveTargets([file]); await restoreTransaction(transaction.id); assert.equal(await fs.readFile(file, 'utf8'), 'old'); await verifyTransaction(current.id)
})
await check('trash tamper rejected without moving data', async () => {
  const file = path.join(root, 'tamper.txt'); await write(file, 'before'); const [transaction] = await moveTargets([file]); const stored = transaction.entries[0].storedPath
  const original = await fs.readFile(stored)
  try { await fs.writeFile(stored, 'changed'); await assert.rejects(() => restoreTransaction(transaction.id), /integrity mismatch/) } finally { await fs.writeFile(stored, original) }
  await restoreTransaction(transaction.id)
})
await check('interrupted restore resumes from actual entry locations', async () => {
  const a = path.join(root, 'resume-a.txt'), b = path.join(root, 'resume-b.txt'); await write(a, 'a'); await write(b, 'b')
  const [transaction] = await moveTargets([a, b]); const manifest = JSON.parse(await fs.readFile(transaction.manifestPath, 'utf8'))
  await write(path.join(root, 'resume-manifest-before.json'), JSON.stringify(manifest)); manifest.state = 'restoring'; await fs.writeFile(transaction.manifestPath, JSON.stringify(manifest))
  await fs.rename(transaction.entries[0].storedPath, a); await restoreTransaction(transaction.id); assert.equal(await fs.readFile(a, 'utf8'), 'a'); assert.equal(await fs.readFile(b, 'utf8'), 'b')
})
await check('manifest stored-path escape refused', async () => {
  const file = path.join(root, 'manifest-test.txt'); await write(file, 'safe'); const [transaction] = await moveTargets([file]); const original = await fs.readFile(transaction.manifestPath, 'utf8'); const altered = JSON.parse(original); altered.entries[0].storedPath = path.join(root, 'not-in-vault.txt')
  try { await fs.writeFile(transaction.manifestPath, JSON.stringify(altered)); await assert.rejects(() => restoreTransaction(transaction.id), /escapes/) } finally { await fs.writeFile(transaction.manifestPath, original) }
  await restoreTransaction(transaction.id)
})
await check('two concurrent moves cannot lose the same file', async () => {
  const file = path.join(root, 'concurrent.txt'); await write(file, 'concurrent'); const results = await Promise.allSettled([moveTargets([file]), moveTargets([file])]); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); const success = results.find(r => r.status === 'fulfilled').value[0]; await restoreTransaction(success.id); assert.equal(await fs.readFile(file, 'utf8'), 'concurrent')
})
await check('Windows kernel lock is released after process termination', async () => {
  const worker = path.join(root, 'lock-worker.mjs'); const module = new URL('../lib/transactions.mjs', import.meta.url).href
  await write(worker, `import { withTrashLock } from ${JSON.stringify(module)}; await withTrashLock(async()=>{ process.stdout.write('locked\\n'); await new Promise(()=>{}); });`)
  const child = spawn(process.execPath, [worker], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`lock worker exited ${code}`))); setTimeout(() => reject(new Error('lock worker timeout')), 5000).unref() })
  const closed = new Promise(resolve => child.once('exit', resolve)); child.kill(); await closed
  await withTrashLock(async () => {})
})
await check('Windows recovery lock excludes another process until released', async () => {
  const worker = path.join(root, 'lock-contender.mjs'); const module = new URL('../lib/transactions.mjs', import.meta.url).href
  await write(worker, `import { withTrashLock } from ${JSON.stringify(module)}; await withTrashLock(async()=>{ process.stdout.write('acquired'); });`)
  let child, output = '', exited
  await withTrashLock(async () => {
    child = spawn(process.execPath, [worker], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', data => { output += data }); exited = new Promise(resolve => child.once('exit', resolve))
    await new Promise(resolve => setTimeout(resolve, 500)); assert.equal(output, '')
  })
  const exit = await exited; assert.equal(exit, 0); assert.equal(output, 'acquired')
})

const report = { ok: failures.length === 0, runDirectory: root, checks, passed: checks.length - failures.length, failed: failures.length, evidenceLevel: 'source API + child-process lock test; desktop/CLI host canaries are separate' }
await write(path.join(root, 'acceptance.json'), `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ ok: report.ok, passed: report.passed, failed: report.failed, report: path.join(root, 'acceptance.json'), failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
