#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

// Only the reviewed manifest grants read access. No recursive source traversal occurs here.
const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, args) => {
  if (index % 2 === 0) pairs.push([value.replace(/^--/, ''), args[index + 1]])
  return pairs
}, []))
const required = ['manifest', 'baseline', 'project', 'contributors', 'tooling', 'output', 'report']
if (process.argv.slice(2).length % 2 || required.some(key => !options[key]) || Object.keys(options).some(key => !required.includes(key))) {
  console.error('Usage: node scripts/export-opensource.mjs --manifest <file> --baseline <source> --project <source> --contributors <docs> --tooling <tools> --output <new-folder> --report <outside-report.json>')
  process.exit(2)
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = (parent, child) => { const value = relative(parent, child); return !value || (!value.startsWith('..') && !isAbsolute(value)) }
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const forbidden = /(^|\/)(?:\.goalmatic|\.git|node_modules|dist|\.vite|\.env(?:\.[^/]*)?|\.npmrc|\.netrc|credentials?[^/]*|tokens?(?:[-_.][^/]*)?|world-state[^/]*|saved-world[^/]*|private|local|tmp|reference-photos?[^/]*|owner-photos?[^/]*|face-crops?[^/]*|evidence|__pycache__)(?:\/|$)|\.(?:log|pem|key|p12|pfx|pyc)$/i
const shapes = [
  ['allworld-capability', /\b(?:gst|gmc|gtx)_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/],
  ['account-cookie-value', /__Host-aw_session=[A-Za-z0-9_-]{32,}/],
  ['embedded-raster-review', /data:image\/(?:png|jpe?g|webp|gif|bmp|heic|avif);base64,\s*[A-Za-z0-9+/]{24,}/i],
  ['private-key', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['openai-secret-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{35}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/],
  ['credential-url', /https?:\/\/[^\s/:]+:[^\s/@]+@/],
  ['assigned-secret', /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|secret[_-]?key)\s*[:=]\s*["'][A-Za-z0-9+/_=-]{24,}["']/i],
  ['developer-home-path', /\/(?:Users|home)\/[A-Za-z0-9._-]+\//],
  ['private-scratch-path', /\/(?:private\/)?tmp\/[^\s"'`]*?(?:private|owner-photo|face-crop|reference-photo)[^\s"'`]*/i],
]
const findings = []
const issue = (path, rule) => { if (!findings.some(row => row.path === path && row.rule === rule)) findings.push({ path, rule }) }
let stage
let manifestBytes
let manifest
let roots
let output
let reportPath
let reportWritable = false
const prepared = []
function safePath(value) { return typeof value === 'string' && value.length > 0 && !isAbsolute(value) && !value.includes('\\') && !value.split('/').some(part => !part || part === '.' || part === '..') }
function sourceFile(root, path, target) {
  let current = root
  for (const [index, part] of path.split('/').entries()) {
    current = join(current, part)
    if (!existsSync(current)) { issue(target, 'missing-source'); return null }
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) { issue(target, 'symlink'); return null }
    if (index < path.split('/').length - 1 ? !stat.isDirectory() : !stat.isFile()) { issue(target, 'not-regular-file'); return null }
    if (index === path.split('/').length - 1 && stat.nlink !== 1) { issue(target, 'hard-link'); return null }
  }
  return current
}
function scan(path, bytes) {
  let unpacked = bytes
  if (path.endsWith('.gz')) {
    try { unpacked = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }) }
    catch { issue(path, 'invalid-or-oversize-gzip'); return }
  }
  for (const content of unpacked === bytes ? [bytes] : [bytes, unpacked]) {
    const text = content.toString('latin1')
    for (const [rule, pattern] of shapes) if (pattern.test(text)) issue(path, rule)
  }
}
try {
  roots = Object.fromEntries(['baseline', 'project', 'contributors', 'tooling'].map(key => [key, realpathSync(resolve(options[key]))]))
  output = join(realpathSync(dirname(resolve(options.output))), basename(resolve(options.output)))
  reportPath = join(realpathSync(dirname(resolve(options.report))), basename(resolve(options.report)))
  if (['baseline', 'project', 'contributors'].some(key => inside(roots[key], reportPath)) || inside(output, reportPath) || reportPath === resolve(options.manifest) || !reportPath.endsWith('.json') || (existsSync(reportPath) && lstatSync(reportPath).isSymbolicLink())) throw new Error('unsafe-report')
  reportWritable = true
  if (Object.values(roots).some(root => inside(root, output) || inside(output, root)) || existsSync(output)) throw new Error('unsafe-output')
  if (basename(resolve(options.manifest)) !== 'export-manifest.json' || lstatSync(resolve(options.manifest)).isSymbolicLink()) throw new Error('unsafe-manifest')
  manifestBytes = readFileSync(resolve(options.manifest))
  manifest = JSON.parse(manifestBytes)
  if (manifest.schema !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('invalid-manifest')
  scan('export-manifest.json', manifestBytes)
  const targets = new Set()
  for (const file of manifest.files) {
    const target = safePath(file.target) ? file.target : '<invalid-path>'
    if (!safePath(file.path) || !safePath(file.target) || !roots[file.root] || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) { issue(target, 'invalid-entry'); continue }
    if (forbidden.test(file.path) || forbidden.test(file.target)) { issue(target, 'forbidden-path'); continue }
    if (targets.has(file.target) || file.target === 'export-manifest.json') { issue(target, 'duplicate-target'); continue }
    targets.add(file.target)
    if (file.kind === 'asset' && (!file.license || !Array.isArray(file.notices) || !file.notices.length)) { issue(target, 'asset-license-missing'); continue }
    const source = sourceFile(roots[file.root], file.path, target)
    if (!source) continue
    const bytes = readFileSync(source)
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) { issue(target, 'source-hash-mismatch'); continue }
    scan(target, bytes)
    if (source === reportPath) { issue(target, 'report-overlaps-source'); continue }
    prepared.push({ target, bytes })
  }
  for (const file of manifest.files) if (file.kind === 'asset') for (const notice of file.notices ?? []) if (!targets.has(notice)) issue(file.target, 'asset-notice-not-selected')
  if (!findings.length) {
    stage = mkdtempSync(join(dirname(output), `.${basename(output)}-`))
    for (const file of prepared) {
      const target = join(stage, file.target)
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 })
      writeFileSync(target, file.bytes, { flag: 'wx', mode: 0o644 })
    }
    writeFileSync(join(stage, 'export-manifest.json'), manifestBytes, { flag: 'wx', mode: 0o644 })
    if (existsSync(output)) throw new Error('output-created-during-export')
    renameSync(stage, output)
    stage = undefined
  }
} catch {
  issue('<export>', 'invalid-input-or-output')
} finally {
  if (stage) rmSync(stage, { recursive: true, force: true })
}
findings.sort((a, b) => compare(a.path, b.path) || compare(a.rule, b.rule))
const result = {
  schema: 1, status: findings.length ? 'blocked' : 'passed',
  manifestSha256: manifestBytes ? hash(manifestBytes) : null,
  selectedFiles: manifest?.files?.length ?? 0, exportedFiles: findings.length ? 0 : prepared.length + 1,
  exportedBytes: findings.length ? 0 : prepared.reduce((sum, file) => sum + file.bytes.length, manifestBytes.length),
  scan: { scope: 'manifest-selected files and decompressed selected gzip content', findings, limitations: 'High-confidence patterns only; no guarantee against unknown secrets or undocumented rights. Unselected files are never opened.' },
  exclusions: manifest?.exclusions ?? [],
}
if (reportWritable) {
  let reportStage
  try {
    reportStage = mkdtempSync(join(dirname(reportPath), '.nw-export-report-'))
    const temporaryReport = join(reportStage, 'report.json')
    writeFileSync(temporaryReport, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(temporaryReport, reportPath)
  } catch { console.error('Could not write export report.'); process.exitCode = 2 }
  finally { if (reportStage) rmSync(reportStage, { recursive: true, force: true }) }
}
for (const row of findings) console.error(`${row.path} ${row.rule}`)
console.log(JSON.stringify({ status: result.status, selectedFiles: result.selectedFiles, exportedFiles: result.exportedFiles, manifestSha256: result.manifestSha256 }))
process.exit(process.exitCode || (findings.length ? 1 : 0))
