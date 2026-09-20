import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const initialized = new Map()
export const pwsh = () => process.env.DSH_SAFEKEEP_PWSH || 'pwsh.exe'
export function safetyRoot() {
  const raw = process.env.DSH_SAFEKEEP_HOME ?? path.join(os.homedir(), '.dsh-safekeep')
  if (!raw || raw !== raw.trim() || !path.isAbsolute(raw) || /[\0*?\[\]{}$%`~]/u.test(raw) || raw.split(/[\\/]/u).includes('..') || /^\\\\/u.test(raw)) throw new Error('DSH_SAFEKEEP_HOME must be a dedicated, absolute local path without shorthand or links')
  const resolved = path.resolve(raw)
  if (resolved === path.parse(resolved).root || resolved.toLowerCase() === path.resolve(os.homedir()).toLowerCase()) throw new Error('storage cannot be the drive or user root')
  if (process.platform === 'win32' && (!/^[A-Za-z]:[\\/]/u.test(raw) || raw.slice(2).includes(':') || raw.split(/[\\/]/u).slice(1).some(p => /[ .]$/u.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(p)))) throw new Error('ambiguous Windows storage path')
  return resolved
}
export async function checkNoLinks(file) {
  let cursor = path.parse(file).root
  for (const part of path.relative(cursor, file).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error(`storage traverses a symbolic link or junction: ${cursor}`) }
    catch (e) { if (e.code === 'ENOENT') return; throw e }
  }
}
export async function secureDirectory(root) {
  if (process.platform !== 'win32') throw new Error('DSH Safekeep currently supports Windows only')
  await checkNoLinks(root)
  if (!initialized.has(root)) initialized.set(root, (async () => {
    await fs.mkdir(root, { recursive: true })
    const marker = path.join(root, '.dsh-safekeep-storage.json')
    await checkNoLinks(marker)
    let owned
    try { owned = JSON.parse(await fs.readFile(marker, 'utf8')) } catch (e) {
      if (e.code !== 'ENOENT') throw e
      const entries = await fs.readdir(root)
      if (entries.length && !entries.includes(path.basename(marker))) throw new Error(`storage directory is nonempty and not owned by DSH Safekeep: ${root}`)
      try { await fs.writeFile(marker, JSON.stringify({ format: 'dsh-safekeep-storage', schema: 1 }), { flag: 'wx' }) }
      catch (e) { if (e.code !== 'EEXIST') throw e }
      owned = JSON.parse(await fs.readFile(marker, 'utf8'))
    }
    if (owned.format !== 'dsh-safekeep-storage' || owned.schema !== 1) throw new Error('unrecognized storage ownership marker')
    const { stdout } = await exec(pwsh(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./storage-acl.ps1', import.meta.url)), '-LiteralPath', root], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 })
    return JSON.parse(stdout.trim().replace(/^\uFEFF/u, ''))
  })().catch(e => { initialized.delete(root); throw e }))
  return initialized.get(root)
}
export const ensureStorage = () => secureDirectory(safetyRoot())
export async function userKey() {
  const result = await ensureStorage()
  return createHash('sha256').update(result.sid).digest('hex').slice(0, 16)
}
