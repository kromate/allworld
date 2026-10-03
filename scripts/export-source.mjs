#!/usr/bin/env node
// Local source export only. No account, network, Git or deployment action.
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const { values } = parseArgs({ options: {
  root: { type: 'string' }, output: { type: 'string' }, reference: { type: 'string' },
  python: { type: 'string', default: 'python3' }, plan: { type: 'boolean', default: false },
  'expect-tree': { type: 'string' }, 'expect-manifest': { type: 'string' }, help: { type: 'boolean', default: false },
} })
if (values.help) {
  console.log('Usage: node scripts/export-source.mjs --root <frozen-source> --output <new-folder> --plan\nThen: --output <another-new-folder> --expect-tree <reviewed-tree-sha256> --expect-manifest <reviewed-manifest-sha256>\nOptional: --reference <reviewed-license-reference.json> --python <python3>')
  process.exit(0)
}
const inside = (parent, child) => { const path = relative(parent, child); return !path || (!path.startsWith('..') && !isAbsolute(path)) }
const hash = data => createHash('sha256').update(data).digest('hex')
const occupied = path => { try { lstatSync(path); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error } }
let stage
function run(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
  if (result.status !== 0) throw new Error('Source audit or export failed. Inspect the local audit metadata; no archive was published.')
  return result.stdout.trim()
}
try {
  if (!values.root || !values.output || (!values.plan && ['expect-tree', 'expect-manifest'].some(key => !/^[a-f0-9]{64}$/.test(values[key] ?? '')))) throw new Error('Provide --root, a fresh --output, and either --plan or both --expect-tree and --expect-manifest.')
  const root = realpathSync(resolve(values.root))
  if (!lstatSync(root).isDirectory() || root.split('/').includes('.goalmatic') || root.split('/').some(part => part.startsWith('nw-private'))) throw new Error('Refused a private source root.')
  const requestedOutput = resolve(values.output)
  if (occupied(requestedOutput)) throw new Error('Output already exists. Use a new path.')
  const parent = realpathSync(dirname(requestedOutput))
  const output = join(parent, basename(requestedOutput))
  if (inside(root, output) || inside(output, root) || occupied(output)) throw new Error('Output must be new and outside the source root.')
  stage = mkdtempSync(join(parent, '.allworld-source-'))
  const manifest = join(stage, 'export-manifest.json')
  const audit = join(stage, 'source-audit.json')
  const reference = realpathSync(resolve(values.reference ?? join(here, 'source-export-reference.json')))
  const auditRun = spawnSync(values.python, [join(here, 'source-export-audit.py'), '--root', root, '--reference', reference, '--manifest', manifest, '--report', audit, '--mode', 'candidate'], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
  if (!existsSync(audit)) throw new Error('The source audit did not produce metadata.')
  const status = JSON.parse(readFileSync(audit, 'utf8'))
  const referenceHash = status.referenceSha256
  const pinned = status.selectedTreeSha256
  if (hash(readFileSync(reference)) !== referenceHash) throw new Error('License reference changed during audit.')
  if (!values.plan && (!status.accepted || auditRun.status !== 0 || pinned !== values['expect-tree'] || hash(readFileSync(manifest)) !== values['expect-manifest'])) throw new Error('The source audit failed or differs from the reviewed tree or manifest. Run --plan and inspect its report.')
  const report = { schema: 1, mode: values.plan ? 'plan' : 'export', selectedTreeSha256: pinned, selectedFiles: status.selectedFiles, referenceSha256: referenceHash, manifestSha256: hash(readFileSync(manifest)), sourceAccepted: status.accepted, findings: status.issues.length, archive: null }
  if (!values.plan) {
    const exported = join(stage, 'source')
    run(process.execPath, [join(here, 'export-opensource.mjs'), '--manifest', manifest, '--baseline', root, '--project', root, '--contributors', root, '--tooling', root, '--output', exported, '--report', join(stage, 'selected-byte-export.json')])
    run(values.python, [join(here, 'source-export-audit.py'), '--root', exported, '--reference', reference, '--manifest', manifest, '--report', join(stage, 'export-audit.json'), '--mode', 'artifact'])
    const packed = JSON.parse(run(values.python, [join(here, 'source-export-archive.py'), '--root', exported, '--manifest', manifest, '--output', join(stage, 'allworld-source.tar.gz')]))
    report.archive = { ...packed, path: 'allworld-source.tar.gz' }
    // The selected source directory is staging only. Deliver the verified archive and metadata.
    rmSync(exported, { recursive: true })
    const sourceNow = join(stage, 'source-now.json')
    run(values.python, [join(here, 'source-export-audit.py'), '--root', root, '--reference', reference, '--manifest', sourceNow, '--report', join(stage, 'source-now-audit.json'), '--mode', 'candidate'])
    if (hash(readFileSync(sourceNow)) !== hash(readFileSync(manifest)) || hash(readFileSync(reference)) !== referenceHash) throw new Error('Source or license reference changed during export; archive discarded.')
    rmSync(sourceNow)
    rmSync(join(stage, 'source-now-audit.json'))
  }
  writeFileSync(join(stage, 'source-export-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  if (occupied(output)) throw new Error('Output appeared during export; refusing to overwrite it.')
  renameSync(stage, output)
  stage = undefined
  console.log(JSON.stringify(report))
  if (!status.accepted) process.exitCode = 1
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Source export failed.')
  process.exitCode = 1
} finally {
  if (stage) rmSync(stage, { recursive: true, force: true })
}
