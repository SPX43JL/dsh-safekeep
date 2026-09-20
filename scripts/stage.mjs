// Explicit source allowlist; fresh destination only, no remote operations.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { check, publicFiles } from './check.mjs'
await check()
const out = process.argv[2]
if (!out || !path.isAbsolute(out) || /[*?~$%]/u.test(out) || out.split(/[\\/]/u).includes('..')) throw new Error('provide a new absolute output directory')
await fs.mkdir(out, { recursive: false })
const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
const destination = path.join(out, 'source'); await fs.mkdir(destination)
const manifest = []
for (const name of await publicFiles()) {
  const data = await fs.readFile(path.join(sourceRoot, name))
  const target = path.join(destination, name)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, data, { flag: 'wx' })
  manifest.push({ path: name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })
}
await fs.writeFile(path.join(out, 'SOURCE-MANIFEST.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ source: destination, files: manifest.length }))
