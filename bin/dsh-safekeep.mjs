#!/usr/bin/env node
import { snapshots, trash, temp, doctor } from '../lib/operations.mjs'
import { buildInfo } from '../lib/build-info.mjs'
const help = `DSH Safekeep (Windows; offline recovery CLI)
  dsh-safekeep doctor
  dsh-safekeep snapshots [--path ABSOLUTE_PATH] [--limit N]
  dsh-safekeep snapshots inspect|verify ID
  dsh-safekeep snapshots restore ID [--to NEW_ABSOLUTE_PATH | --in-place]
  dsh-safekeep trash list|verify|restore [ID]
  dsh-safekeep trash move ABSOLUTE_PATH
  dsh-safekeep temp create [LABEL]
  dsh-safekeep temp list|retire [ABSOLUTE_PATH]
Recovery data stays on disk after uninstall. No purge command.
doctor checks this CLI and storage; data_safety_status checks the live DSH plugin.`
try {
  const [group, ...tokens] = process.argv.slice(2)
  if (!group || ['--help', '-h'].includes(group)) { process.stdout.write(`${help}\n`); process.exit(0) }
  if (group === '--version') { process.stdout.write(`${buildInfo().version}\n`); process.exit(0) }
  let result
  if (group === 'doctor') {
    if (tokens.length) throw new Error('doctor takes no arguments')
    result = await doctor()
  } else {
    if (!['snapshots', 'trash', 'temp'].includes(group)) throw new Error('unknown command; use --help')
    const positional = [], options = {}
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      if (!token.startsWith('--')) { positional.push(token); continue }
      if (!['--path', '--limit', '--to', '--in-place'].includes(token) || token in options) throw new Error(`unknown or duplicate option: ${token}`)
      if (token === '--in-place') options[token] = true
      else {
        const value = tokens[++i]
        if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`)
        options[token] = value
      }
    }
    const [action = 'list', value, extra] = positional
    if (extra !== undefined) throw new Error('too many arguments')
    const allowed = group === 'snapshots' && action === 'list' ? ['--path', '--limit'] : group === 'snapshots' && action === 'restore' ? ['--to', '--in-place'] : action === 'list' ? ['--limit'] : []
    if (Object.keys(options).some(k => !allowed.includes(k))) throw new Error('option is not valid for this action')
    if (action === 'list' && value !== undefined) throw new Error('list takes options, not a positional value')
    const args = { action, id: value, path: options['--path'] ?? value, label: value, to: options['--to'], in_place: options['--in-place'], limit: options['--limit'] === undefined ? undefined : Number(options['--limit']) }
    result = await ({ snapshots, trash, temp }[group])(args)
  }
  process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
  process.exitCode = 1
}
