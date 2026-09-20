import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { assertNoLinks, exists, safetyRoot, writeExclusive } from './paths.mjs'

export async function treeIntegrity(root) {
  const entries = []
  async function walk(file, relative) {
    const before = await fs.lstat(file)
    if (before.isSymbolicLink()) { entries.push({ path: relative, type: 'link', target: await fs.readlink(file) }); return }
    if (before.isDirectory()) {
      entries.push({ path: relative, type: 'directory' })
      for (const name of (await fs.readdir(file)).sort()) await walk(path.join(file, name), relative ? `${relative}/${name}` : name)
    } else if (before.isFile()) {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(file)) hash.update(chunk)
      const after = await fs.lstat(file)
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) throw new Error(`file changed during integrity scan: ${file}`)
      entries.push({ path: relative, type: 'file', bytes: after.size, sha256: hash.digest('hex') })
    } else throw new Error(`unsupported filesystem entry: ${file}`)
  }
  await assertNoLinks(path.dirname(root))
  await walk(root, '')
  return { algorithm: 'sha256-tree-v1', sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), entries: entries.length, bytes: entries.reduce((sum, e) => sum + (e.bytes ?? 0), 0) }
}

export async function verifyTree(file, expected) {
  const actual = await treeIntegrity(file)
  if (expected && (expected.algorithm !== actual.algorithm || expected.sha256 !== actual.sha256 || expected.entries !== actual.entries || expected.bytes !== actual.bytes)) throw new Error(`recovery content integrity mismatch: ${file}`)
  return actual
}

// A single process lock serializes explicit trash/restore operations, including
// overlapping directory targets. Released/stale lock records are retained.
export async function withTrashLock(operation) {
  if (process.platform === 'win32') {
    const pipe = `\\\\.\\pipe\\dsh-safekeep-trash-${createHash('sha256').update(safetyRoot().toLowerCase()).digest('hex').slice(0, 24)}`
    const deadline = Date.now() + 5000
    let server
    while (!server) {
      const candidate = net.createServer(socket => socket.destroy())
      try {
        await new Promise((resolve, reject) => { candidate.once('error', reject); candidate.listen(pipe, resolve) })
        server = candidate
      } catch (error) {
        candidate.close()
        if (!['EADDRINUSE', 'EACCES'].includes(error.code) || Date.now() >= deadline) throw new Error(`another recovery operation is active or the recovery lock is unavailable: ${error.code}`)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    // Windows releases the named pipe on process exit, including a crash. No
    // stale lock deletion or PID-reuse inference is needed on this local target.
    try { return await operation() } finally { await new Promise(resolve => server.close(resolve)) }
  }
  const root = path.join(safetyRoot(), 'state', 'trash-locks')
  await assertNoLinks(root)
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const lock = path.join(root, 'active.json')
  const owner = { pid: process.pid, token: randomUUID(), at: new Date().toISOString() }
  const deadline = Date.now() + 5000
  while (true) {
    try { await writeExclusive(lock, JSON.stringify(owner)); break } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let prior
      try { prior = JSON.parse(await fs.readFile(lock, 'utf8')) } catch { throw new Error(`unreadable recovery lock; retained for inspection: ${lock}`) }
      let alive = true
      try { process.kill(prior.pid, 0) } catch (e) { if (e.code === 'ESRCH') alive = false }
      if (!alive) throw new Error(`stale recovery lock retained for manual inspection: ${lock}`)
      if (Date.now() >= deadline) throw new Error(`another recovery operation is active (PID ${prior.pid}); retry after it finishes`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  try { return await operation() } finally {
    if (await exists(lock)) {
      const current = JSON.parse(await fs.readFile(lock, 'utf8'))
      if (current.token === owner.token) await fs.rename(lock, path.join(root, `released-${owner.token}.json`))
    }
  }
}
