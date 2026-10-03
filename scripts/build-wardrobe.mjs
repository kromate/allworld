// Offline only. WARDROBE_PYTHON must provide Pillow and numpy.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root = fileURLToPath(new URL('../', import.meta.url))
// The accepted m08/m12 caps reuse the existing local headwear authoring pipeline.
// This mode leaves the fabric collection and rejected garment prototypes alone.
if (process.argv.includes('--headwear')) {
  const python = `
import pathlib, sys
source = pathlib.Path('scripts/wardrobe/garments/headwear_round4.py').resolve()
sys.path.insert(0, str(source.parent))
namespace = {'__file__': str(source), '__name__': 'accepted_headwear'}
exec(compile(source.read_text().replace('"prototype": True', '"prototype": False'), str(source), 'exec'), namespace)
namespace['OUT'] = pathlib.Path('public/wardrobe').resolve()
original = namespace['cap_geometry']
def smooth(source, style):
    vertices, faces, uv, fit, rings = original(source, style)
    sectors = namespace['SECTORS']
    # Keep the measured forehead band fixed; soften source-scalp steps above it.
    for _ in range(2):
        before = vertices[:]
        for row in range(4, len(namespace['HEIGHT_FRACTIONS']) - 1):
            for col in range(sectors + 1):
                at = row * (sectors + 1) + col
                a, b, c = before[at-sectors-1], before[at], before[at+sectors+1]
                vertices[at] = tuple(.22*a[k] + .56*b[k] + .22*c[k] for k in range(3))
    return vertices, faces, uv, fit, rings
namespace['cap_geometry'] = smooth
sys.argv = ['build-headwear', '--', 'm08', 'm12']
namespace['main']()
`
  execFileSync(process.env.WARDROBE_BLENDER || '/Volumes/Blender/Blender.app/Contents/MacOS/Blender', ['-b', '--factory-startup', '--python-expr', python], { cwd: root, stdio: 'inherit' })
  copyFileSync(root + 'scripts/wardrobe/garments/prototypes/headwear-cloth.pack.gz', root + 'public/wardrobe/headwear-cloth.pack.gz')
  const manifest = {}
  for (const file of readdirSync(root + 'public/wardrobe', { recursive: true }).filter(file => file.endsWith('.pack.gz')).sort()) {
    const bytes = readFileSync(root + 'public/wardrobe/' + file)
    manifest[file] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  writeFileSync(root + 'public/wardrobe/manifest.json', JSON.stringify(manifest, null, 2) + '\n')
  process.exit(0)
}
execFileSync(process.execPath, ['scripts/wardrobe/geometry.mjs'], { cwd: root, stdio: 'ignore' })
execFileSync(process.env.WARDROBE_PYTHON || 'python3', [process.argv.includes('--legacy') ? 'scripts/wardrobe/build.py' : 'scripts/wardrobe/shared_fabrics.py'], { cwd: root, stdio: 'inherit' })
