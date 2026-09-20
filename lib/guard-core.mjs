import path from 'node:path'

const SEGMENT_START = String.raw`(?:^\s*|[\r\n;|&{}()]\s*|\b(?:then|do|else)\s+)`
const COMMAND_PREFIX = String.raw`(?:(?:sudo|doas|command)\s+|env(?:\s+-[^\s]+)*\s+)*(?:(?:cmd(?:\.exe)?\s+\/[ck]|(?:pwsh|powershell)(?:\.exe)?\b[^\r\n;&|]*?-(?:Command|c)|(?:bash|sh|zsh)(?:\.exe)?\s+-[A-Za-z]*c)\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*`

function atCommandBoundary(commandPattern, flags = 'iu') {
  return new RegExp(`${SEGMENT_START}${COMMAND_PREFIX}${commandPattern}`, flags)
}

const HIGH_RISK_PATTERNS = Object.freeze([
  {
    code: 'PERMANENT_DELETE',
    pattern: atCommandBoundary(String.raw`(?:rm|unlink|rmdir)(?:\.exe)?\b`),
    summary: 'permanent file deletion is blocked; use ai-safe-trash with an explicit absolute path',
  },
  {
    code: 'POWERSHELL_DELETE',
    pattern: atCommandBoundary(String.raw`(?:&\s*)?(?:(?:Microsoft\.PowerShell\.Management)\\)?(?:Remove-Item|Clear-Content|ri|clc)\b`),
    summary: 'PowerShell deletion or truncation is blocked; use ai-safe-trash or create a versioned output',
  },
  {
    code: 'QUOTED_DELETE_INVOKE',
    inspectOriginal: true,
    pattern: /(?:^|[\r\n;|&{}()]\s*)&\s*["'](?:rm|unlink|rmdir|del|erase|rd|Remove-Item|Clear-Content)["']/iu,
    summary: 'invoking a quoted deletion command is blocked',
  },
  {
    code: 'WINDOWS_DELETE',
    pattern: atCommandBoundary(String.raw`(?:del|erase|rd|rmdir)(?:\.exe)?\b`),
    summary: 'Windows permanent deletion is blocked; use ai-safe-trash',
  },
  {
    code: 'REMOTE_DESTRUCTIVE',
    pattern: atCommandBoundary(String.raw`(?:ssh|plink)(?:\.exe)?\b[^\r\n;&|]*(?:\s(?:rm|unlink|rmdir|del|erase|rd|Remove-Item|Clear-Content)\b|\bfind\b[^\r\n;&|]*(?:-delete|-exec\s+(?:rm|unlink)\b)|\bgit\b[^\r\n;&|]*(?:\bclean\b|\breset\b[^\r\n;&|]*--hard\b|\brestore\b)|\brsync\b[^\r\n;&|]*--delete\b)`),
    summary: 'a destructive command sent to a remote host is blocked; use a versioned remote path or an explicitly managed recovery mechanism',
  },
  {
    code: 'PROGRAMMATIC_DELETE',
    pattern: /(?:^\s*|[;\r\n{}]\s*)(?:await\s+)?(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir|removedirs)|Path\([^)]*\)\.(?:unlink|rmdir)|(?:fs|require\(\s*[^)]*\s*\))\.(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)|Deno\.remove|File\.Delete|Directory\.Delete|\[(?:System\.)?IO\.(?:File|Directory)\]::Delete)\s*\(/iu,
    summary: 'programmatic deletion is blocked; use the reversible trash helper',
  },
  {
    code: 'FIND_DELETE',
    pattern: atCommandBoundary(String.raw`find(?:\.exe)?\b[^\r\n;&|]*(?:-delete|-exec\s+(?:rm|unlink)\b)`),
    summary: 'recursive find deletion is blocked',
  },
  {
    code: 'GIT_DESTRUCTIVE',
    pattern: atCommandBoundary(String.raw`git(?:\.exe)?\b[^\r\n;&|]*(?:\bclean\b|\breset\b[^\r\n;&|]*--hard\b|\brestore\b|\bcheckout\b[^\r\n;&|]*(?:--force\b|-f\b|\s--\s)|\bswitch\b[^\r\n;&|]*--discard-changes\b)`),
    summary: 'destructive Git cleanup/reset/restore is blocked; preserve the current tree and use a new branch or backup',
  },
  {
    code: 'SYNC_DELETE',
    pattern: atCommandBoundary(String.raw`(?:rsync\b[^\r\n;&|]*--delete\b|robocopy\b[^\r\n;&|]*(?:/MIR|/PURGE)\b)`),
    summary: 'mirroring with destination deletion is blocked',
  },
  {
    code: 'TRUNCATE_OR_SHRED',
    pattern: atCommandBoundary(String.raw`(?:(?:truncate|shred|sdelete)(?:\.exe)?\b|dd\b[^\r\n;&|]*\bof=)`),
    summary: 'truncation, shredding, or raw overwrite is blocked',
  },
  {
    code: 'POWERSHELL_TRUNCATE',
    inspectOriginal: true,
    pattern: /\b(?:Set-Content|Out-File)\b[^\r\n;&|]*(?:-Value\s+(?:\$null|["']{2})|-NoNewline\s+-Force\b)/iu,
    summary: 'explicit content truncation is blocked; write a versioned output or use an edit tool with a snapshot',
  },
  {
    code: 'BULK_OVERWRITE',
    pattern: /\b(?:Get-ChildItem|ForEach-Object)\b[^\r\n;&|]*(?:Set-Content|Out-File|Copy-Item|Move-Item)\b|\b(?:Copy-Item|Move-Item)\b[^\r\n;&|]*(?:-Recurse[^\r\n;&|]*-Force|-Force[^\r\n;&|]*-Recurse)/iu,
    summary: 'bulk overwrite or move is blocked; snapshot targets and use a versioned destination',
  },
  {
    code: 'DISK_DESTRUCTIVE',
    pattern: /\b(?:Format-Volume|Clear-Disk|Remove-Partition|diskpart|mkfs(?:\.[a-z0-9]+)?|wipefs)(?:\.exe)?\b/iu,
    summary: 'disk or partition destruction is blocked',
  },
  {
    code: 'DATABASE_DESTRUCTIVE',
    pattern: /\b(?:DROP\s+(?:DATABASE|SCHEMA|TABLE)|TRUNCATE\s+TABLE)\b/iu,
    summary: 'direct destructive database statements are blocked; use a reviewed migration and backup',
  },
  {
    code: 'INFRA_DESTRUCTIVE',
    pattern: /\b(?:terraform|tofu|pulumi)\s+destroy\b|\bdocker\s+system\s+prune\b[^\r\n;&|]*(?:-a|--all|--volumes)|\bkubectl\s+delete\s+(?:namespace|ns|persistentvolume|pv|persistentvolumeclaim|pvc)\b/iu,
    summary: 'broad infrastructure or volume destruction is blocked',
  },
  {
    code: 'CACHE_PURGE',
    pattern: /\b(?:conda\s+clean\s+--all|npm\s+cache\s+clean\s+--force|pip\s+cache\s+purge|huggingface-cli\s+delete-cache)\b/iu,
    summary: 'broad cache cleanup is blocked unless it is an explicit user task',
  },
  {
    code: 'OBFUSCATED_COMMAND',
    pattern: /(?:-EncodedCommand\b|\bInvoke-Expression\b|\biex\s*\(|\beval\s+)/iu,
    summary: 'obfuscated or dynamically evaluated shell commands are blocked in unattended mode',
  },
  {
    code: 'PIPE_TO_SHELL',
    pattern: /\|\s*(?:bash|sh|zsh|pwsh|powershell|cmd)(?:\.exe)?\b/iu,
    summary: 'piping generated text into a command interpreter is blocked',
  },
  {
    code: 'DYNAMIC_SHELL_PAYLOAD',
    inspectOriginal: true,
    pattern: /\b(?:cmd(?:\.exe)?\s+\/[ck]|(?:pwsh|powershell)(?:\.exe)?\b[^\r\n]*?-(?:Command|c)\b|(?:bash|sh|zsh)(?:\.exe)?\s+-[A-Za-z]*c)\s+(?:\$|%[A-Za-z_][A-Za-z0-9_]*%|\(|\{)/iu,
    summary: 'a dynamically resolved nested shell payload is blocked',
  },
])

const AMBIGUOUS_PATH_MARKERS = Object.freeze([
  { code: 'DYNAMIC_ENV_PATH', pattern: /\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*|\$\{[^}]*\}|%[A-Za-z_][A-Za-z0-9_]*%/u },
  { code: 'WILDCARD_PATH', pattern: /[*?\[\]{}]/u },
  { code: 'PARENT_PATH', pattern: /(?:^|[\s"'\\/])\.\.(?:[\s"'\\/]|$)/u },
  { code: 'HOME_SHORTHAND_PATH', pattern: /(?:^|[\s"'])~(?:[\\/\s"']|$)/u },
])

function maskQuotedText(value) {
  let quote
  let escaped = false
  let output = ''
  for (const character of value) {
    if (quote !== undefined) {
      if (escaped) {
        escaped = false
      } else if (character === '\\' || (quote === '"' && character === '`')) {
        escaped = true
      } else if (character === quote) {
        quote = undefined
      }
      output += ' '
    } else if (character === '"' || character === "'") {
      quote = character
      output += ' '
    } else {
      output += character
    }
  }
  return output
}

function nestedInterpreterPayloads(command) {
  const patterns = [
    /\bcmd(?:\.exe)?\s+\/[ck]\s+(["'])([\s\S]*?)\1/giu,
    /\b(?:pwsh|powershell)(?:\.exe)?\b[^\r\n]*?-(?:Command|c)\s+(["'])([\s\S]*?)\1/giu,
    /\b(?:bash|sh|zsh)(?:\.exe)?\s+-[A-Za-z]*c\s+(["'])([\s\S]*?)\1/giu,
    /\b(?:python(?:3(?:\.\d+)?)?|py|node)(?:\.exe)?(?:\s+-\d+(?:\.\d+)?)?\s+(?:-c|-e)\s+(["'])([\s\S]*?)\1/giu,
    /\b(?:ssh|plink)(?:\.exe)?\b[^\r\n;&|]*?(["'])([\s\S]*?)\1/giu,
  ]
  const payloads = []
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) payloads.push(match[2])
  }
  return payloads
}

// Only exempt a complete simple invocation. An adjacent command never inherits
// a preview flag, and subexpressions are deliberately excluded from exemptions.
export function isReadOnlyInvocation(command) {
  const s = command.trim()
  if (/[;|&\r\n`]/u.test(s) || /\$\(|[{}]/u.test(s)) return false
  const visible = maskQuotedText(s)
  if (/^(?:rm|unlink|rmdir|shred|truncate)\s+--(?:help|version)\s*$/iu.test(s)) return true
  if (/^(?:Remove-Item|Clear-Content|ri|clc|Set-Content|Add-Content|Out-File|Copy-Item|Move-Item)\b/iu.test(s) &&
      /(?:^|\s)-WhatIf(?::\$true)?(?:\s|$)/iu.test(visible) && !/-WhatIf:\$(?:false|[\w]+)(?:\s|$)/iu.test(visible.replace(/-WhatIf:\$true/giu, ''))) return true
  if (/^Remove-Item\s+(?:-LiteralPath\s+|-Path\s+)?(?:variable|env):[^\s]+\s*$/iu.test(s)) return true
  if (/^git\s+(?:clean|restore)\s+--help\s*$/iu.test(s)) return true
  if (/^git\s+clean\b/iu.test(s) && /(?:^|\s)(?:--dry-run|-[a-zA-Z]*n[a-zA-Z]*)(?:\s|$)/u.test(visible.split(/\s--\s/u)[0])) return true
  if (/^git\s+restore\b/iu.test(s) && /(?:^|\s)(?:--staged|-S)(?:\s|$)/u.test(visible.split(/\s--\s/u)[0]) && !/(?:--worktree|-[A-Za-z]*W)/u.test(visible)) return true
  if (/^robocopy\b/iu.test(s) && /(?:^|\s)\/L(?:\s|$)/iu.test(visible)) return true
  if (/^conda\s+clean\b/iu.test(s) && /(?:^|\s)--dry-run(?:\s|$)/u.test(visible)) return true
  return false
}

function classifyOne(command) {
  if (isReadOnlyInvocation(command)) return undefined
  const masked = maskQuotedText(command)
  for (const entry of HIGH_RISK_PATTERNS) {
    const inspected = entry.inspectOriginal ? command : masked
    if (entry.pattern.test(inspected)) return entry
  }
  return undefined
}

export function classifyCommand(command, depth = 0) {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { blocked: true, code: 'EMPTY_COMMAND', summary: 'empty or non-string command input is blocked', pathRisk: undefined }
  }
  if (command.includes('\0')) {
    return { blocked: true, code: 'NUL_COMMAND', summary: 'command contains a NUL byte', pathRisk: undefined }
  }

  const matched = classifyOne(command)
  if (matched) {
    const pathRisk = AMBIGUOUS_PATH_MARKERS.find((entry) => entry.pattern.test(command))?.code
    return { blocked: true, code: matched.code, summary: matched.summary, pathRisk }
  }

  if (depth < 2) {
    for (const payload of nestedInterpreterPayloads(command)) {
      const nested = classifyCommand(payload, depth + 1)
      if (nested.blocked) return { ...nested, nested: true }
    }
  }
  if (/^\s*(?:sqlite3|psql|mysql)(?:\.exe)?\b/iu.test(command) && /\b(?:DROP\s+(?:DATABASE|SCHEMA|TABLE)|TRUNCATE\s+TABLE)\b/iu.test(command)) {
    return { blocked: true, code: 'DATABASE_DESTRUCTIVE', summary: 'destructive database statement in client arguments' }
  }
  return { blocked: false }
}

export function extractPatchTargets(patchText) {
  if (typeof patchText !== 'string') return []
  const targets = []
  for (const line of patchText.split(/\r?\n/u)) {
    const match = /^\*\*\* (Update|Delete|Add) File: (.+)$/u.exec(line)
    if (match) {
      targets.push({ action: match[1].toLowerCase(), path: match[2].trim() })
      continue
    }
    const move = /^\*\*\* Move to: (.+)$/u.exec(line)
    if (move) targets.push({ action: 'move-to', path: move[1].trim() })
  }
  return targets
}

export function classifyPatch(patchText) {
  const targets = extractPatchTargets(patchText)
  const deletion = targets.find((target) => target.action === 'delete')
  if (deletion) {
    return {
      blocked: true,
      code: 'PATCH_DELETE',
      summary: `patch deletion of ${JSON.stringify(deletion.path)} is blocked; move it with ai-safe-trash instead`,
      targets,
    }
  }
  return { blocked: false, targets }
}

export function patchTextForTool(toolName, toolInput = {}) {
  const name = String(toolName ?? '').toLowerCase()
  if (!['apply_patch', 'applypatch'].includes(name)) return undefined
  for (const key of ['command', 'patch', 'patch_text', 'input']) {
    if (typeof toolInput?.[key] === 'string') return toolInput[key]
  }
  return ''
}

export function isShellTool(toolName, toolInput = {}) {
  if (typeof toolInput?.command !== 'string') return false
  return /^(?:bash|pwsh|powershell|shell|terminal|exec_command)$/iu.test(String(toolName ?? ''))
}

function unquoteToken(token) {
  const trimmed = token.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function extractNamedPowerShellPaths(command) {
  const targets = []
  const patterns = [
    /\b(?:Set-Content|Add-Content)\b[^\r\n;|&]*?-(?:LiteralPath|Path)\s+("[^"]*"|'[^']*'|[^\s;|&]+)/giu,
    /\b(?:Out-File|Tee-Object)\b[^\r\n;|&]*?-FilePath\s+("[^"]*"|'[^']*'|[^\s;|&]+)/giu,
    /\b(?:Copy-Item|Move-Item)\b[^\r\n;|&]*?-Destination\s+("[^"]*"|'[^']*'|[^\s;|&]+)/giu,
  ]
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) targets.push(unquoteToken(match[1]))
  }
  return targets
}

function extractRedirectPaths(command) {
  const targets = []
  let quote
  let escaped = false
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (quote !== undefined) {
      if (escaped) escaped = false
      else if (character === '\\' || (quote === '"' && character === '`')) escaped = true
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character !== '>') continue
    while (command[index + 1] === '>') index += 1
    let cursor = index + 1
    while (/\s/u.test(command[cursor] ?? '')) cursor += 1
    if (command[cursor] === '&') continue
    const targetQuote = command[cursor] === '"' || command[cursor] === "'" ? command[cursor] : undefined
    if (targetQuote !== undefined) cursor += 1
    let target = ''
    while (cursor < command.length) {
      const current = command[cursor]
      if (targetQuote !== undefined ? current === targetQuote : /[\s;|&]/u.test(current)) break
      target += current
      cursor += 1
    }
    if (target.length > 0) targets.push(target)
  }
  return targets
}

export function shellMutationTargets(command) {
  if (typeof command !== 'string') return []
  if (isReadOnlyInvocation(command)) return []
  return [...new Set([...extractNamedPowerShellPaths(command), ...extractRedirectPaths(command)])].filter(p => !/^(?:\$null|NUL|\/dev\/null)$/iu.test(p))
}

export function mutationTargetsForTool(toolName, toolInput = {}) {
  const name = String(toolName ?? '').toLowerCase()
  const patchText = patchTextForTool(toolName, toolInput)
  if (patchText !== undefined) {
    return extractPatchTargets(patchText)
      .filter((target) => ['update', 'move-to', 'add'].includes(target.action))
      .map((target) => target.path)
  }
  if (isShellTool(toolName, toolInput)) return shellMutationTargets(toolInput.command)
  const candidates = []
  if (['edit', 'write', 'multiedit', 'notebookedit'].includes(name)) {
    const candidate = toolInput.file_path ?? toolInput.path ?? toolInput.notebook_path
    if (typeof candidate === 'string') candidates.push(candidate)
  }
  if (name === 'str_replace_editor') {
    const action = String(toolInput.command ?? '').toLowerCase()
    if (['str_replace', 'insert', 'create'].includes(action) && typeof toolInput.path === 'string') candidates.push(toolInput.path)
  }
  return candidates
}

export function resolveMutationPath(rawPath, cwd) {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) throw new Error('mutation target path is empty')
  const candidate = rawPath.trim()
  if (candidate !== rawPath) throw new Error('leading or trailing whitespace in mutation target')
  if (candidate.includes('\0')) throw new Error('mutation target path contains NUL')
  if (/\$(?:env:)?[A-Za-z_]|\$\{|%[A-Za-z_][A-Za-z0-9_]*%|[*?\[\]{}]|(?:^|[\\/])\.\.(?:[\\/]|$)|^~[\\/]|^\(|`/u.test(candidate)) {
    throw new Error(`mutation target must be a resolved literal path without variables, wildcards, parent traversal, expressions, or home shorthand: ${candidate}`)
  }
  const base = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : process.cwd()
  if (!path.isAbsolute(base)) throw new Error(`mutation cwd is not absolute: ${base}`)
  if (process.platform === 'win32') {
    if (/^\\\\[?.]\\/u.test(candidate) || /^[A-Za-z]:(?:$|[^\\/])/u.test(candidate) || /^\\(?!\\)/u.test(candidate)) throw new Error(`device or drive-relative mutation path: ${candidate}`)
    if (/^(?:\\\\|\/\/)/u.test(candidate)) throw new Error('remote/UNC mutation paths are outside the supported local-drive scope')
    const tail = candidate.replace(/^[A-Za-z]:/u, '')
    if (tail.includes(':')) throw new Error(`provider or alternate data stream path: ${candidate}`)
    if (tail.split(/[\\/]/u).some(part => /[ .]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) throw new Error(`ambiguous Windows path component: ${candidate}`)
  }
  return path.resolve(base, candidate)
}

export function riskReason(risk) {
  const pathNote = risk.pathRisk ? ` Path validation also found ${risk.pathRisk}.` : ''
  const nestedNote = risk.nested ? ' The destructive operation was found inside a nested interpreter payload.' : ''
  return `AI data-safety guard blocked ${risk.code}: ${risk.summary}.${pathNote}${nestedNote} Resolve and verify the exact absolute target; use ai-safe-trash for user-requested removal.`
}
