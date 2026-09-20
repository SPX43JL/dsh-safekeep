import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyCommand, isReadOnlyInvocation, resolveMutationPath, shellMutationTargets } from './guard-core.mjs'
import { pwsh } from './storage.mjs'

const parserPath = fileURLToPath(new URL('./powershell-analysis.ps1', import.meta.url))
const writes = new Set(['set-content', 'sc', 'add-content', 'ac', 'out-file', 'tee-object', 'export-csv', 'export-clixml', 'copy-item', 'cpi', 'copy', 'move-item', 'mi', 'move', 'new-item', 'ni'])
const switches = new Set(['force', 'recurse', 'append', 'noclobber', 'nonewline', 'notypeinformation', 'passthru', 'verbose', 'debug', 'whatif', 'confirm', 'nocontainer', 'useculture', 'asbytestream'])

function parsePowerShell(command) {
  return new Promise((resolve, reject) => {
    const child = execFile(pwsh(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', parserPath],
      { windowsHide: true, timeout: 6000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) return reject(new Error(`PowerShell path analysis failed: ${stderr.trim() || error.message}`))
        try { resolve(JSON.parse(stdout.replace(/^\uFEFF/u, ''))) } catch { reject(new Error('PowerShell path analysis returned invalid JSON')) }
      })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ command }))
  })
}

function bindingsAt(parsed, offset, top) {
  const values = new Map()
  if (!top) return values
  for (const assignment of parsed.assignments.filter(a => a.start < offset).sort((a, b) => a.start - b.start)) {
    const name = assignment.name.toLowerCase()
    values.delete(name)
    if (assignment.top && assignment.end < offset && assignment.operator === 'Equals' && assignment.value?.kind === 'literal') {
      // A literal assignment is resolved only while no intervening statement can
      // have changed it. This intentionally doesn't evaluate arbitrary code.
      const harmlessReads = /^(?:test-path|get-item|get-childitem|get-content|get-command|get-filehash|resolve-path|write-output|out-null|select-object|where-object)$/iu
      const intervening = parsed.commands.some(c => c.start > assignment.end && c.end < offset && !harmlessReads.test(c.name ?? ''))
      if (!intervening) values.set(name, assignment.value.value)
    }
  }
  return values
}

function resolveExpression(expression, bindings) {
  if (!expression) throw new Error('missing mutation path')
  if (expression.kind === 'array') return expression.items.flatMap(item => resolveExpression(item, bindings))
  if (expression.kind === 'literal') return [expression.value]
  if (expression.kind === 'variable' && bindings.has(expression.variable.toLowerCase())) return [bindings.get(expression.variable.toLowerCase())]
  throw new Error(`mutation path cannot be resolved statically: ${expression.text}; use a literal path or an immediately preceding literal assignment`)
}

function argumentsOf(command) {
  const named = new Map(), positional = []
  for (let i = 1; i < command.elements.length; i++) {
    const element = command.elements[i]
    if (element.kind !== 'parameter') { positional.push(element); continue }
    const name = element.name.toLowerCase()
    if (named.has(name)) throw new Error(`duplicate parameter -${element.name}`)
    if (element.argument) named.set(name, element.argument)
    else if (switches.has(name)) named.set(name, { kind: 'switch' })
    else if (command.elements[i + 1]?.kind !== 'parameter') named.set(name, command.elements[++i])
    else named.set(name, null)
  }
  return { named, positional }
}

// Native AST parsing is only paid for on relevant Windows shell invocations.
// The parser reads text; it never executes the supplied command or expressions.
export async function analyzePowerShell(command, cwd) {
  if (process.platform !== 'win32') return { risk: classifyCommand(command), targets: shellMutationTargets(command) }
  const interesting = /[>]|\b(?:set-content|add-content|out-file|tee-object|export-csv|export-clixml|copy-item|move-item|new-item|sc|ac|cpi|mi|ni|copy|move|remove-item|clear-content|ri|clc|rm|rmdir|robocopy|set-location|push-location|pop-location|cd|chdir|sl)\b|\bgit\s+(?:clean|restore)\b|\bconda\s+clean\b/iu.test(command)
  if (!interesting) return { risk: classifyCommand(command), targets: [] }
  const parsed = await parsePowerShell(command)
  if (parsed.errors.length) {
    // Foreign-shell syntax is not interpreted as PowerShell. Preserve the old
    // supported shell behavior rather than claiming a successful AST analysis.
    return { risk: classifyCommand(command), targets: shellMutationTargets(command), analysis: 'fallback' }
  }
  // Classify actual invocations individually. A quote in an earlier argument
  // cannot hide a later command, and literal script examples stay data.
  const previews = parsed.commands.filter(c => isReadOnlyInvocation(c.text))
  const risks = [...parsed.commands.filter(c => !previews.includes(c)).map(c => classifyCommand(c.text)), ...parsed.memberCalls.map(text => classifyCommand(text))]
  const risk = risks.find(r => r.blocked) ?? (command.trim() ? { blocked: false } : classifyCommand(command))
  if (risk.blocked) return { risk, targets: [], analysis: 'powershell-ast' }
  const targets = []
  let effectiveCwd = cwd
  const locations = []
  let cwdKnown = true
  const items = [...parsed.commands.map(c => ({ ...c, kind: 'command' })), ...parsed.redirects.map(r => ({ ...r, kind: 'redirect' }))].sort((a, b) => a.start - b.start)
  for (const item of items) {
    const bindings = bindingsAt(parsed, item.start, item.top)
    const absolutize = expression => resolveExpression(expression, bindings).map(raw => {
      if (!cwdKnown && !path.isAbsolute(raw)) throw new Error('relative write after a dynamic or conditional directory change; use an absolute path')
      return resolveMutationPath(raw, effectiveCwd)
    })
    if (item.kind === 'redirect') {
      if (item.path.kind === 'variable' && item.path.variable.toLowerCase() === 'null') continue
      targets.push(...absolutize(item.path)); continue
    }
    const name = (item.name ?? '').toLowerCase().replace(/^microsoft\.powershell\.(?:management|utility)\\/u, '')
    if (previews.includes(item) || isReadOnlyInvocation(item.text)) continue
    if (['set-location', 'push-location', 'pop-location', 'cd', 'chdir', 'sl'].includes(name)) {
      try {
        if (!item.top) throw new Error('conditional cwd')
        const { named, positional } = argumentsOf(item)
        if (name === 'pop-location') { effectiveCwd = locations.pop(); if (!effectiveCwd) throw new Error('unknown stack') }
        else {
          const values = absolutize(named.get('literalpath') ?? named.get('path') ?? positional[0])
          if (values.length !== 1) throw new Error('multiple cwd values')
          if (name === 'push-location') locations.push(effectiveCwd)
          effectiveCwd = values[0]
        }
      } catch { cwdKnown = false }
      continue
    }
    if (!writes.has(name)) continue
    const { named, positional } = argumentsOf(item)
    const copyOrMove = ['copy-item', 'cpi', 'copy', 'move-item', 'mi', 'move'].includes(name)
    let expression = copyOrMove
      ? named.get('destination') ?? positional[named.has('literalpath') || named.has('path') ? 0 : 1]
      : named.get('literalpath') ?? named.get('path') ?? named.get('filepath') ?? positional[0]
    if (['new-item', 'ni'].includes(name) && /^(?:directory|junction|symboliclink)$/iu.test(named.get('itemtype')?.value ?? '')) continue
    let destinations = absolutize(expression)
    if (['new-item', 'ni'].includes(name) && named.has('name')) {
      const leaf = resolveExpression(named.get('name'), bindings)
      if (leaf.length !== 1 || path.basename(leaf[0]) !== leaf[0]) throw new Error('New-Item -Name must be a single filename')
      destinations = destinations.map(d => path.join(d, leaf[0]))
    }
    for (const dest of destinations) {
      let stat
      try { stat = await fs.lstat(dest) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (copyOrMove && stat?.isDirectory()) {
        const sources = absolutize(named.get('literalpath') ?? named.get('path') ?? positional[0])
        for (const source of sources) {
          const sourceStat = await fs.lstat(source)
          if (!sourceStat.isFile()) throw new Error('copy/move into an existing directory requires individual files or a new versioned destination')
          targets.push(path.join(dest, path.basename(source)))
        }
      } else targets.push(dest)
    }
  }
  if (targets.length > 100) throw new Error('more than 100 write targets in one tool call; split the work into smaller batches')
  return { risk, targets: [...new Set(targets)], analysis: 'powershell-ast' }
}
