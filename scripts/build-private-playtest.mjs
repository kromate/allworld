// Standalone production build. Deliberately does not load vite.config.mjs or .env.
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { previewBuildInfo } from './preview/build-info.mjs'
import ts from 'typescript'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, copyFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const root = await realpath(join(dirname(fileURLToPath(import.meta.url)), '..'))
const sourcePackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const visionPackage = JSON.parse(await readFile(join(root, 'node_modules/@mediapipe/tasks-vision/package.json'), 'utf8'))
if (visionPackage.version !== sourcePackage.dependencies['@mediapipe/tasks-vision']) {
  throw new Error('The installed face engine differs from package.json. Build with the declared dependency version.')
}
const args = process.argv.slice(2)
if (args.length !== 4 || args[0] !== '--out' || args[2] !== '--config') {
  throw new Error('Usage: node scripts/build-private-playtest.mjs --out /fresh/external/build --config /public/config.json')
}
const output = resolve(args[1])
const configPath = resolve(args[3])
const within = (parent, child) => { const r = relative(parent, child); return r === '' || (!r.startsWith('..' + '/') && r !== '..' && !isAbsolute(r)) }
const parent = await realpath(dirname(output))
if (parent !== dirname(output) || within(root, output) || within(output, root)) throw new Error('Output must be outside the repository, with a real, existing parent and no symlink ancestors.')
if (/(^|\/)\.env(?:\.|$)/.test(configPath)) throw new Error('Supply a non-secret public JSON config, never an .env file.')
const config = JSON.parse(await readFile(configPath, 'utf8'))
const keys = ['origin', 'audience', 'siteId', 'packageId', 'channel', 'buildId']
const optionalKeys = ['guestAdmission', 'endpoint']
if (!config || Array.isArray(config) || keys.some(key => !(key in config)) || Object.keys(config).some(key => !keys.includes(key) && !optionalKeys.includes(key))) throw new Error('Public config requires origin/audience/siteId/packageId/channel/buildId and permits only optional guestAdmission/endpoint.')
if (config.guestAdmission !== undefined && config.guestAdmission !== 'public' && config.guestAdmission !== 'invite') throw new Error('guestAdmission must be public or invite.')
for (const key of [...keys, ...(config.endpoint === undefined ? [] : ['endpoint'])]) if (typeof config[key] !== 'string' || !config[key] || config[key].length > 256 || /[\x00-\x20\x7f]/.test(config[key])) throw new Error(`Invalid public config field: ${key}`)
for (const key of ['origin', 'audience', ...(config.endpoint === undefined ? [] : ['endpoint'])]) {
  const url = new URL(config[key])
  if (url.protocol !== 'https:' || url.origin !== config[key] || url.username || url.password) throw new Error(`${key} must be an exact HTTPS origin without credentials, path or query.`)
}
if ((config.endpoint ?? config.audience) !== config.origin || config.channel !== 'test') throw new Error('This private playtest unit requires its endpoint at the serving origin and a test-channel listener.')
const { origin, ...hosted } = config

// Compile the actual runtime hook against the generated object before Vite can emit a build.
const virtualCheck = join(root, '__private_playtest_config_check__.ts')
const checkSource = `import { configureHostedWorld } from ${JSON.stringify(join(root, 'src/platform/runtime.ts'))};\nconfigureHostedWorld(${JSON.stringify(hosted)});\n`
const parsed = ts.parseJsonConfigFileContent(JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8')), ts.sys, root)
const host = ts.createCompilerHost(parsed.options)
const originalSource = host.getSourceFile.bind(host)
host.getSourceFile = (name, language, onError, fresh) => name === virtualCheck ? ts.createSourceFile(name, checkSource, language, true) : originalSource(name, language, onError, fresh)
const program = ts.createProgram([virtualCheck], parsed.options, host)
const diagnostics = ts.getPreEmitDiagnostics(program).filter(d => !d.file || d.file.fileName === virtualCheck)
const runtime = program.getSourceFile(join(root, 'src/platform/runtime.ts'))
const hook = runtime?.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'configureHostedWorld')
const parameter = hook?.parameters[0]
const shape = parameter && program.getTypeChecker().getPropertiesOfType(program.getTypeChecker().getTypeAtLocation(parameter)).map(p => p.name).sort()
if (!shape || Object.keys(hosted).some(key => !shape.includes(key)) || shape.some(key => !optionalKeys.includes(key) && !(key in hosted)) || diagnostics.length) {
  throw new Error('Hosted runtime hook dependency is not ready or changed. ' + ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: s => s, getCurrentDirectory: () => root, getNewLine: () => '\n' }))
}
const main = await readFile(join(root, 'main.ts'), 'utf8')
const routes = [...main.matchAll(/\bpath:\s*['"]([^'"]+)['"]/g)].map(m => m[1]).filter(p => !p.includes('pathMatch'))
if (!routes.includes('/') || routes.some(p => !/^\/(?:[A-Za-z0-9_:-]+\/)*[A-Za-z0-9_:-]*$/.test(p))) throw new Error('App routes changed; review direct-route extraction.')

// mkdir is exclusive: never empty, overwrite or adopt an existing output directory.
await mkdir(output)
const publicDir = join(root, 'public')
const manifest = JSON.parse(await readFile(join(root, 'src/assets/public-assets.index.json'), 'utf8'))
const publicFiles = new Set(Object.keys(manifest.assets).map(p => p.slice(1)))
const wardrobe = await readFile(join(root, 'src/world/wardrobe.ts'), 'utf8')
const wardrobeIds = new Set([...wardrobe.matchAll(/\bid:\s*'([\w-]+)'/g)].map(m => m[1]))
async function supportFiles(directory, prefix = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = prefix + entry.name
    if (name === 'cast' || name.startsWith('cast/') || entry.name.startsWith('.')) continue
    if (entry.isSymbolicLink()) throw new Error(`Public asset symlink refused: ${name}`)
    if (entry.isDirectory()) await supportFiles(join(directory, entry.name), name + '/')
    else if (/\.(md|txt)$/.test(name) || /^(?:regions\/manifest|packs\/surface-sources|wardrobe\/(?:manifest|round2-manifest|sources))\.json$/.test(name)
      || (/^avatars\/[fm]\d\d\.jpg$/.test(name) && publicFiles.has(name.replace('.jpg', '.pack.gz')))
      || (/^wardrobe\/[\w-]+\.jpg$/.test(name) && wardrobeIds.has(entry.name.replace(/(?:-swatch)?\.jpg$/, '')))) publicFiles.add(name)
  }
}
await supportFiles(publicDir)
for (const name of [...publicFiles].sort()) {
  if (!/^(avatars|wardrobe|packs|regions)\/[\w./-]+$/.test(name) || name.split('/').some(p => p.startsWith('.')) || name === 'packs/characters.pack.gz') throw new Error(`Unreviewed public asset: ${name}`)
  const source = join(publicDir, name)
  if (!(await lstat(source)).isFile() || await realpath(source) !== source) throw new Error(`Non-regular public asset: ${name}`)
  const expected = manifest.assets['/' + name]
  if (expected) {
    const bytes = await readFile(source)
    const unpacked = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes
    if (bytes.length !== expected.bytes || unpacked.length !== expected.unpacked || createHash('sha256').update(unpacked).digest('hex') !== expected.sha256) throw new Error(`Stale asset manifest: ${name}`)
  }
  await mkdir(dirname(join(output, name)), { recursive: true })
  await copyFile(source, join(output, name))
}
const entry = '/__private_playtest_entry__.ts'
const configText = JSON.stringify(config, null, 2) + '\n'
await writeFile(join(output, 'playtest-config.json'), configText)
await build({
  root, configFile: false, envDir: false, envPrefix: [], publicDir: false, base: '/', logLevel: 'warn', cacheDir: join(output, '.build-cache'),
  plugins: [previewBuildInfo({ sourceFiles: ['scripts/build-private-playtest.mjs'], buildIdentity: config }), vue(), {
    name: 'private-playtest-entry',
    enforce: 'pre',
    transformIndexHtml: { order: 'pre', handler(html) {
      if (!html.includes('src="/main.ts"')) throw new Error('App HTML entry changed; review boot hook.')
      return html.replace('src="/main.ts"', `src="${entry}"`)
    } },
    resolveId(id) {
      if (id === entry) return '\0' + entry
      if (id.startsWith('/') && publicFiles.has(id.slice(1))) return '\0private-public:' + id
    },
    load(id) {
      if (id.startsWith('\0private-public:')) return `export default ${JSON.stringify(id.slice('\0private-public:'.length))};`
      // The transfer capture is the entry's only static import, so it runs before any other chunk (contract 125).
      if (id === '\0' + entry) return `import ${JSON.stringify(join(root, 'src/platform/transferFragment.ts'))};\nconst { configureHostedWorld } = await import(${JSON.stringify(join(root, 'src/platform/runtime.ts'))});\nif (location.origin !== ${JSON.stringify(origin)}) throw new Error('Private playtest origin mismatch.');\nconfigureHostedWorld(${JSON.stringify(hosted)});\nawait import(${JSON.stringify(join(root, 'main.ts'))});`
    },
    generateBundle(_options, bundle) {
      // A face engine upgrade must not quietly restore the usage logger audited in CLAUDE-VISION-PRIVACY.md.
      for (const item of Object.values(bundle)) {
        const content = item.type === 'chunk' ? item.code : typeof item.source === 'string' ? item.source : Buffer.from(item.source).toString('utf8')
        if (content.includes('odml.pa.googleapis.com')) throw new Error('The face engine contains external usage logging. Review its privacy behavior before building a playtest.')
      }
      for (const item of Object.values(bundle)) if (item.type === 'chunk') for (const id of Object.keys(item.modules)) {
        if (id.startsWith(join(root, 'service') + '/') || id.startsWith(join(root, 'scripts') + '/') || /\/public\/cast\//.test(id)) throw new Error('Forbidden module in frontend build.')
      }
    },
  }],
  build: { outDir: output, emptyOutDir: false, sourcemap: false, target: 'es2022', chunkSizeWarningLimit: 900 },
})
const files = {}
async function inventory(directory, prefix = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (entry.name.startsWith('.')) throw new Error('Unexpected hidden output; build is not deliverable.')
    const name = prefix + entry.name
    if (entry.isDirectory()) await inventory(join(directory, entry.name), name + '/')
    else if (entry.isFile()) files[name] = { bytes: (await lstat(join(directory, entry.name))).size, sha256: createHash('sha256').update(await readFile(join(directory, entry.name))).digest('hex'), immutable: /^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[\w.]+$/.test(name) }
    else throw new Error('Unexpected non-regular build output.')
  }
}
await inventory(output)
const metadata = { schema: 1, config, assetRevision: manifest.revision, routes, files }
metadata.artifactSha256 = createHash('sha256').update(JSON.stringify(metadata)).digest('hex')
await writeFile(join(output, 'playtest-build.json'), JSON.stringify(metadata, null, 2) + '\n')
console.log(`Private playtest build prepared: ${Object.keys(files).length + 1} files; artifact ${metadata.artifactSha256}. No listener or remote build created.`)
