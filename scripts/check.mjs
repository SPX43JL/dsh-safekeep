import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = fileURLToPath(new URL('../', import.meta.url))
export const roots = ['bin', 'lib', 'test', 'scripts', 'docs', '.github', 'dsh-plugin.mjs', 'cordis.patch.yml', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'NOTICE', 'SECURITY.md', 'CONTRIBUTING.md', '.gitignore', '.gitattributes']
export async function publicFiles() {
  const files = []
  async function visit(relative) {
    const full = path.join(root, relative), stat = await fs.lstat(full)
    if (stat.isSymbolicLink()) throw new Error(`public source contains a link: ${relative}`)
    if (stat.isDirectory()) for (const name of await fs.readdir(full)) await visit(`${relative}/${name}`)
    else files.push(relative)
  }
  for (const name of roots) await visit(name)
  return files.sort()
}
export async function check() {
  const files = await publicFiles(), failures = []
  const forbidden = [/[CD]:[\\/]Users[\\/](?!Public(?:[\\/]|$))[^\s"'\\/]+/iu, /(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{20,}/u, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u, /(?:localhost|127\.0\.0\.1):\d+[^\s]*[?&]token=/iu]
  for (const file of files) {
    if (/\.(?:png|jpg|zip|tgz)$/iu.test(file)) continue
    const content = await fs.readFile(path.join(root, file), 'utf8')
    if (forbidden.some(pattern => pattern.test(content))) failures.push(`private-data pattern: ${file}`)
    if (file.endsWith('.mjs')) {
      const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { windowsHide: true, encoding: 'utf8' })
      if (result.status !== 0) failures.push(`syntax: ${file}: ${result.stderr}`)
    }
    if (file.endsWith('.md')) for (const match of content.matchAll(/\]\(([^)]+)\)/gu)) {
      const link = match[1].split('#')[0]
      if (!link || /^(?:https?:|mailto:)/u.test(link)) continue
      try { await fs.access(path.resolve(root, path.dirname(file), decodeURIComponent(link))) } catch { failures.push(`broken link: ${file} -> ${link}`) }
    }
  }
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.peerDependencies ?? {}).length) failures.push('unexpected runtime dependencies')
  if (!pkg.private || !pkg.scripts.prepublishOnly) failures.push('npm publication guard missing')
  if (failures.length) throw new Error(failures.join('\n'))
  return { ok: true, files: files.length, runtimeDependencies: 0, note: 'Targeted scan, syntax and links; manual review remains necessary.' }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await check(), null, 2))
