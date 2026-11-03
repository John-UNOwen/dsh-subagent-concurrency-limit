// Fails when the committed lib/ is not what src/ builds to.
// lib/ is committed so a GitHub install needs no build step; run
// `pnpm run build` and commit lib/ together with every src/ change.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'

const out = '.lib-check'
rmSync(out, { recursive: true, force: true })
const tsc = join('node_modules', 'typescript', 'bin', 'tsc')
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--outDir', out], { stdio: 'inherit' })

const files = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
        .sort()
    : []
// Line endings may differ on a Windows checkout.
const read = (dir, file) => readFileSync(join(dir, file), 'utf8').replaceAll('\r\n', '\n')

const built = files(out)
const committed = new Set(files('lib'))
const stale = built.filter((file) => !committed.has(file) || read(out, file) !== read('lib', file))
const extra = [...committed].filter((file) => !built.includes(file))
rmSync(out, { recursive: true, force: true })
if (stale.length > 0 || extra.length > 0) {
  for (const file of stale) console.error(`lib/${file} is out of date`)
  for (const file of extra) console.error(`lib/${file} is not built from src/`)
  console.error('Run `pnpm run build` and commit lib/.')
  process.exit(1)
}
console.log(`lib/ matches src/ (${built.length} files)`)
