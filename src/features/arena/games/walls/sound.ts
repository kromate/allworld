// Sound cues for Ten Walls, made with WebAudio as they are needed — no audio files. They play on
// the shared "effects" channel (src/state/sound.ts), so nothing plays until the player switches
// sound on, and the audio context is only created by that same tap.
import { cueBus, unlockCues } from '../../../../state/sound.ts'

export type Cue = 'step' | 'jump' | 'wall' | 'refused' | 'won' | 'lost'

/** Call from a tap or key press so the browser allows sound afterwards. */
export function unlockSound(): void { unlockCues() }

interface Note { at: number; from: number; to: number; length: number; shape: OscillatorType; level: number }

const CUES: Record<Cue, Note[]> = {
  step: [{ at: 0, from: 520, to: 380, length: 0.07, shape: 'triangle', level: 0.16 }],
  jump: [
    { at: 0, from: 430, to: 640, length: 0.08, shape: 'triangle', level: 0.15 },
    { at: 0.09, from: 600, to: 420, length: 0.08, shape: 'triangle', level: 0.15 },
  ],
  wall: [
    { at: 0, from: 170, to: 80, length: 0.13, shape: 'square', level: 0.1 },
    { at: 0.01, from: 900, to: 300, length: 0.04, shape: 'triangle', level: 0.07 },
  ],
  refused: [{ at: 0, from: 150, to: 120, length: 0.14, shape: 'sawtooth', level: 0.06 }],
  won: [
    { at: 0, from: 523, to: 523, length: 0.12, shape: 'triangle', level: 0.14 },
    { at: 0.12, from: 659, to: 659, length: 0.12, shape: 'triangle', level: 0.14 },
    { at: 0.24, from: 784, to: 784, length: 0.24, shape: 'triangle', level: 0.14 },
  ],
  lost: [
    { at: 0, from: 392, to: 370, length: 0.16, shape: 'triangle', level: 0.12 },
    { at: 0.17, from: 311, to: 277, length: 0.28, shape: 'triangle', level: 0.12 },
  ],
}

export function playCue(cue: Cue): void {
  const bus = cueBus('effects')
  if (!bus) return
  const { ctx, out } = bus
  const start = ctx.currentTime + 0.01
  for (const note of CUES[cue]) {
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.type = note.shape
    oscillator.frequency.setValueAtTime(note.from, start + note.at)
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(40, note.to), start + note.at + note.length)
    gain.gain.setValueAtTime(0.0001, start + note.at)
    gain.gain.exponentialRampToValueAtTime(note.level, start + note.at + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + note.length)
    oscillator.connect(gain).connect(out)
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect() }
    oscillator.start(start + note.at)
    oscillator.stop(start + note.at + note.length + 0.02)
  }
}
