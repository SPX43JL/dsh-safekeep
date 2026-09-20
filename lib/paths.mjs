import { promises as fs } from 'node:fs'
import path from 'node:path'
import { safetyRoot } from './storage.mjs'

export { safetyRoot }
export const samePath = (a, b) => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b)
export function inside(candidate, root) {
  const rel = path.relative(root, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

// Check every existing component, including parents of a not-yet-created file.
// This is an accident guard; it does not claim to defeat concurrent hostile swaps.
export async function assertNoLinks(absolutePath) {
  if (!path.isAbsolute(absolutePath)) throw new Error('expected an absolute path')
  const root = path.parse(absolutePath).root
  let cursor = root
  const parts = path.relative(root, absolutePath).split(path.sep).filter(Boolean)
  for (const part of parts) {
    cursor = path.join(cursor, part)
    let stat
    try { stat = await fs.lstat(cursor) } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`path traverses a symbolic link or junction: ${cursor}; use the verified real path`)
  }
}

export function assertOutsideVault(absolutePath) {
  const protectedRoots = [path.join(safetyRoot(), 'recovery'), path.join(safetyRoot(), 'logs'), path.join(safetyRoot(), 'state'), path.join(safetyRoot(), 'backups')]
  if (protectedRoots.some(root => samePath(root, absolutePath) || inside(absolutePath, root)) ||
      samePath(absolutePath, safetyRoot()) ||
      absolutePath.split(/[\\/]+/u).some(part => /^(?:\._?dsh-safekeep-[a-f0-9]{16}|\._?ai-safety-recovery)$/iu.test(part))) {
    throw new Error(`recovery storage is not a normal edit target: ${absolutePath}`)
  }
}

export async function exists(file) {
  try { await fs.lstat(file); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export async function writeExclusive(file, data) {
  const handle = await fs.open(file, 'wx', 0o600)
  try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
}
