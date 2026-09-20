import path from 'node:path'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildInfo } from './build-info.mjs'
import { analyzePowerShell } from './powershell.mjs'
import { classifyCommand, classifyPatch, isShellTool, mutationTargetsForTool, patchTextForTool, resolveMutationPath, riskReason } from './guard-core.mjs'

export function dshBuildInfo() {
  const base = buildInfo()
  return { ...base, codeHash: createHash('sha256').update(base.codeHash).update(readFileSync(new URL('../dsh-plugin.mjs', import.meta.url))).digest('hex'), adapterPath: fileURLToPath(new URL('../dsh-plugin.mjs', import.meta.url)) }
}

export function executionCwd(exec) {
  const cwd = exec.agent?.session?.header?.cwd ?? process.cwd()
  // DSH 0.1.5 resolves a shell workdir relative to the session's workspace.
  return isShellTool(exec.name, exec.arguments) && exec.arguments.workdir !== undefined
    ? resolveMutationPath(exec.arguments.workdir, cwd) : cwd
}

export function executionSignature(exec) {
  return JSON.stringify([exec.name, exec.arguments, executionCwd(exec)])
}

export async function analyzeDshExecution(exec) {
  const args = exec.arguments ?? {}, cwd = executionCwd(exec)
  const patch = patchTextForTool(exec.name, args)
  if (patch !== undefined) return { cwd, risk: classifyPatch(patch), targets: mutationTargetsForTool(exec.name, args), analysis: 'patch' }
  if (isShellTool(exec.name, args)) {
    // Native pwsh uses the same tested parse-only analyzer. Bash is not PowerShell.
    if (/^(?:pwsh|powershell)$/iu.test(exec.name) && process.platform === 'win32') return { cwd, ...await analyzePowerShell(args.command, cwd) }
    return { cwd, risk: classifyCommand(args.command), targets: mutationTargetsForTool(exec.name, args), analysis: 'shell-text' }
  }
  return { cwd, risk: { blocked: false }, targets: mutationTargetsForTool(exec.name, args), analysis: 'tool-targets' }
}

export function denialReason(risk) {
  const reason = risk.code === 'PATCH_DELETE' ? `DSH Safekeep blocked ${risk.code}: ${risk.summary}.` : riskReason(risk)
  return reason.replaceAll('ai-safe-trash', 'data_safety_trash (action=move) or dsh-safekeep trash move')
}

export function needsPreflight(exec) {
  return isShellTool(exec.name, exec.arguments) || mutationTargetsForTool(exec.name, exec.arguments).length > 0 || patchTextForTool(exec.name, exec.arguments) !== undefined
}
