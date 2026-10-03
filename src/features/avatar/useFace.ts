// The member's own photo face: load it, replace it, change who sees it, remove it.
import { ref } from 'vue'
import { WorldError } from '../../shared/model.ts'
import type { AvatarLook, FaceAudience, FaceScan, MemberProfile } from '../../shared/model.ts'
import { api, app, messageOf, onAccountReset, toast } from '../../state/app.ts'
import { refreshLocalAvatar } from '../../state/world.ts'
import type { FaceScanResult } from './faceScan.ts'

// Every account or session change counts here, so an answer can be matched to the session that asked.
let session = 0
onAccountReset(() => { session++ })

export function useFace() {
  const scan = ref<FaceScan | null>(null)
  const busy = ref(false)
  let loads = 0

  /** Says whether the member and session that asked are still the ones here. An answer for anyone else is dropped. */
  function asker(): () => boolean {
    const id = app.me?.id, at = session
    return () => id !== undefined && at === session && app.me?.id === id
  }

  async function load(): Promise<void> {
    const mine = asker(), turn = ++loads
    const face = app.me?.look.face
    if (!face || !app.me) { scan.value = null; return }
    let found: FaceScan | null = null
    try { found = (await api('member.face', { memberId: app.me.id, version: face.version })).scan } catch { /* shown as no photo */ }
    if (mine() && turn === loads) scan.value = found
  }

  /** True only when the service answered this member. `kept` runs once its profile is the one held here. */
  async function run(work: () => Promise<MemberProfile>, done: string, kept?: () => void): Promise<boolean> {
    if (busy.value || !app.me) return false
    const mine = asker()
    busy.value = true
    try {
      const profile = await work()
      if (!mine()) return false
      // A profile this page already holds in a newer revision is not put back; the photo is read again for it.
      if (profile.revision >= app.me.revision) { app.me = profile; kept?.() } else void load()
      toast(done, 'good')
      try { await refreshLocalAvatar() } catch (error) { if (mine()) toast(messageOf(error), 'bad') }
      return mine()
    } catch (error) {
      // No answer is not a refusal: the service may hold the change, so it is not reported as failed or as done.
      if (mine()) toast(error instanceof WorldError && error.code === 'unavailable' ? `That was not confirmed. ${error.message} Check your character before you try again.` : messageOf(error), 'bad')
      return false
    } finally { busy.value = false }
  }

  /** Keeps the photo and the whole look it was chosen with in one step. The revision is the one that look was made against. */
  const save = (result: FaceScanResult, audience: FaceAudience, look: AvatarLook): Promise<boolean> => {
    const saved = { ...result.scan, ...(result.views ? { views: result.views } : {}) }
    const expectedRevision = app.me?.revision ?? 0
    return run(async () => (await api('member.setFace', { scan: saved, audience, look, expectedRevision })).profile,
      audience === 'friends' ? 'Photo face added. Only friends will see it.' : 'Photo face added.', () => { loads++; scan.value = saved })
  }

  const setAudience = (audience: FaceAudience): Promise<boolean> => run(async () => (await api('member.setFaceAudience', { audience })).profile,
    audience === 'friends' ? 'Only friends see your photo face now.' : 'Other players in Allworld can see your photo face now.')

  const clear = (): Promise<boolean> => run(async () => (await api('member.clearFace', {})).profile, 'Photo face removed.', () => { loads++; scan.value = null })

  void load()
  return { scan, busy, load, save, setAudience, clear }
}
