import { reactive } from 'vue'
import { ASSET_REVISION } from '../assets/publicAssets.ts'

export interface BuildInfo { id: string; assets: string }
function readBuild(value: unknown): BuildInfo | null {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' || !/^[a-f0-9]{12}$/.test(value.id)
    || !('assets' in value) || typeof value.assets !== 'string' || !value.assets) return null
  return { id: value.id, assets: value.assets }
}
const injected: unknown = null /* preview build metadata */
export const pageBuild = readBuild(injected)
export const buildInfo = reactive({ latest: null as BuildInfo | null, checking: false, checked: false, unavailable: false, dismissed: '' })
export const assetRevision = ASSET_REVISION
let metadataBase = import.meta.env.BASE_URL
/** The anonymous entry supplies the same verified native base used by its public packs. */
export function configureBuildBase(basePath: string): void { metadataBase = basePath }
export async function checkBuild(): Promise<void> {
  if (!pageBuild || buildInfo.checking) return
  buildInfo.checking = true
  try {
    const response = await fetch(`${metadataBase}app-build.json`, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error('Build information is unavailable')
    const next = readBuild(await response.json())
    if (!next) throw new Error('Build information is invalid')
    buildInfo.latest = next
    buildInfo.unavailable = false
  } catch { buildInfo.unavailable = true }
  finally { buildInfo.checking = false; buildInfo.checked = true }
}
export function startBuildChecks(): () => void {
  if (!pageBuild) return () => undefined
  const checkVisible = (): void => { if (!document.hidden) void checkBuild() }
  checkVisible()
  const timer = window.setInterval(checkVisible, 30000)
  document.addEventListener('visibilitychange', checkVisible)
  window.addEventListener('focus', checkVisible)
  return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', checkVisible); window.removeEventListener('focus', checkVisible) }
}
