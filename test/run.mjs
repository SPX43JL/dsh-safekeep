// Every run creates and retains its own fixtures and isolated user/storage roots.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createTaskTemp } from '../lib/safe-temp.mjs'
import { fileURLToPath } from 'node:url'
const parent = process.env.DSH_SAFEKEEP_TEST_ROOT ?? (await createTaskTemp('tests')).path
const root = await fs.mkdtemp(path.join(parent, 'safekeep-test-'))
const home = path.join(root, 'user')
await fs.mkdir(home)
const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_SAFEKEEP_HOME: path.join(home, '.dsh-safekeep'), DSH_HOME: path.join(home, '.dsh') }
const suite = process.argv.includes('--integration') ? ['dsh.mjs', 'ptc.mjs', 'failure.mjs'] : ['recovery.mjs', 'public.mjs']
let ok = true
for (const test of suite) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(test, import.meta.url))], { env, windowsHide: true, encoding: 'utf8', timeout: 180000 })
  await fs.writeFile(path.join(root, `${test}.log`), `${result.stdout ?? ''}\n${result.stderr ?? ''}`, { flag: 'wx' })
  process.stdout.write(`${test}: exit=${result.status}\n${result.stdout ?? ''}${result.stderr ?? ''}`)
  if (result.status !== 0) ok = false
}
process.stdout.write(`Retained test run: ${root}\n`)
process.exitCode = ok ? 0 : 1
