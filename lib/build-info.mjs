import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
export function buildInfo() {
  const files = ['package.json', 'cordis.patch.yml', ...['bin', 'lib'].flatMap(dir => readdirSync(path.join(root, dir)).filter(name => /\.(?:mjs|ps1)$/u.test(name)).map(name => `${dir}/${name}`))].sort()
  const hash = createHash('sha256')
  for (const file of files) hash.update(file).update('\0').update(readFileSync(path.join(root, file)))
  return { version: JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version, codeHash: hash.digest('hex') }
}
