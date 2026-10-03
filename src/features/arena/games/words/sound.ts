// Word Yard's sound cues: a few short notes made on the spot with WebAudio — no sound files. They
// play on the shared "effects" channel (src/state/sound.ts): off until the player turns them on,
// remembered on this device, and shared with the other boards.
import { computed } from 'vue'
import { channels, cueBus, setChannelMuted, unlockCues } from '../../../../state/sound.ts'

export const soundOn = computed(() => !channels.effects.muted)

export function setSound(on: boolean): void {
  setChannelMuted('effects', !on)
  if (on) { unlockCues(); cue('place') }
}

export type Cue = 'place' | 'lift' | 'play' | 'theirs' | 'refused' | 'over'

/** One note: a pitch gliding to another, with a quick fade so nothing clicks. */
function note(ctx: AudioContext, out: AudioNode, at: number, from: number, to: number, length: number, level: number, shape: OscillatorType = 'sine'): void {
  const oscillator = ctx.createOscillator(), gain = ctx.createGain()
  const start = ctx.currentTime + at
  oscillator.type = shape
  oscillator.frequency.setValueAtTime(from, start)
  oscillator.frequency.exponentialRampToValueAtTime(to, start + length)
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(level, start + 0.008)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length)
  oscillator.connect(gain).connect(out)
  oscillator.onended = () => { oscillator.disconnect(); gain.disconnect() }
  oscillator.start(start)
  oscillator.stop(start + length + 0.02)
}

export function cue(kind: Cue): void {
  const bus = cueBus('effects')
  if (!bus) return
  const { ctx, out } = bus
  const play = (at: number, from: number, to: number, length: number, level: number, shape?: OscillatorType): void => note(ctx, out, at, from, to, length, level, shape)
  if (kind === 'place') play(0, 620, 380, 0.07, 0.16, 'triangle')
  else if (kind === 'lift') play(0, 360, 520, 0.06, 0.1, 'triangle')
  else if (kind === 'play') { play(0, 523, 523, 0.11, 0.14); play(0.1, 659, 659, 0.11, 0.14); play(0.2, 784, 784, 0.2, 0.14) }
  else if (kind === 'theirs') { play(0, 440, 440, 0.1, 0.1); play(0.11, 392, 392, 0.16, 0.1) }
  else if (kind === 'refused') { play(0, 196, 180, 0.14, 0.14, 'square'); play(0.17, 174, 160, 0.2, 0.14, 'square') }
  else { play(0, 392, 392, 0.14, 0.13); play(0.14, 523, 523, 0.14, 0.13); play(0.28, 659, 659, 0.14, 0.13); play(0.42, 784, 784, 0.36, 0.13) }
}
