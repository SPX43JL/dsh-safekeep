// Actual ToolRuntime, deliberately unavailable PowerShell for a NEW store only.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as plugin from '../dsh-plugin.mjs'
const root = await fs.mkdtemp(path.join(process.env.USERPROFILE, 'failure-'))
process.env.DSH_SAFEKEEP_HOME = path.join(root, 'new-store')
process.env.DSH_SAFEKEEP_PWSH = path.join(root, 'never-installed-pwsh.exe')
await fs.writeFile(path.join(root, 'keep.txt'), 'failure-before', { flag: 'wx' })
const ctx = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
let bodies = 0
ctx.tools.register(defineTool({ name: 'write', description: 'Inert write', parameters: { file_path: { type: 'string', required: true } }, output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }, execute() { bodies++; return 'must-not-run' } }))
await ctx.plugin(plugin)
const agent = { session: { id: 'failure-test', header: { cwd: root } } }
const call = (name, args) => ctx.tools.execute({ name, arguments: args, agent, callId: name, signal: new AbortController().signal })
const denied = await call('write', { file_path: 'keep.txt' })
assert(denied.isError); assert.equal(bodies, 0)
assert.equal(await fs.readFile(path.join(root, 'keep.txt'), 'utf8'), 'failure-before')
const status = await call('data_safety_status', {})
assert(!status.isError); assert.equal(JSON.parse(status.content[0].text).storage.ok, false)
console.log(JSON.stringify({ ok: true, passed: 3, checks: ['early tool call denied when storage initialization fails', 'original bytes and inert body unchanged', 'status remains available and reports storage failure'] }))
