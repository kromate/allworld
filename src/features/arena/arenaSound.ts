// The hall's own sound cues, made with WebAudio as they are needed — no audio files. A board may
// have its own sounds for its moves; these are only what the hall knows about: it became your
// turn, your time is nearly gone, someone wrote in the chat, the game ended. They play on the
// shared "ui" channel (src/state/sound.ts), so they are silent unless the member has switched hall
// sound on, and Master and the channel's volume apply.
import { cueBus, unlockCues } from '../../state/sound.ts'

export type HallCue = 'turn' | 'low' | 'chat' | 'end' | 'offer'

/** Call from a tap or key press so the browser allows sound afterwards. */
export function unlockHallSound(): void { unlockCues() }

const CUES: Record<HallCue, { at: number; hz: number; length: number; level: number }[]> = {
  turn: [{ at: 0, hz: 660, length: 0.09, level: 0.12 }, { at: 0.1, hz: 880, length: 0.12, level: 0.12 }],
  low: [{ at: 0, hz: 440, length: 0.06, level: 0.1 }],
  chat: [{ at: 0, hz: 990, length: 0.05, level: 0.06 }],
  offer: [{ at: 0, hz: 587, length: 0.1, level: 0.1 }, { at: 0.12, hz: 587, length: 0.1, level: 0.1 }],
  end: [{ at: 0, hz: 523, length: 0.12, level: 0.12 }, { at: 0.13, hz: 392, length: 0.2, level: 0.12 }],
}

export function hallCue(cue: HallCue): void {
  const bus = cueBus('ui')
  if (!bus) return
  const { ctx, out } = bus
  for (const note of CUES[cue]) {
    const start = ctx.currentTime + note.at
    const tone = ctx.createOscillator(), gain = ctx.createGain()
    tone.type = 'triangle'
    tone.frequency.setValueAtTime(note.hz, start)
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(note.level, start + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + note.length)
    tone.connect(gain).connect(out)
    tone.onended = () => { tone.disconnect(); gain.disconnect() }
    tone.start(start)
    tone.stop(start + note.length + 0.02)
  }
}
