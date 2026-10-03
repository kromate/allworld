// Sound cues for the chess board, made on the spot with WebAudio (no sound files). They play on
// the shared "effects" channel (src/state/sound.ts): off until the player turns them on, remembered
// on this device, and shared with the other boards.
import { computed } from 'vue'
import { channels, cueBus, setChannelMuted, unlockCues } from '../../../../state/sound.ts'

export const soundOn = computed(() => !channels.effects.muted)

export type Cue = 'move' | 'capture' | 'check' | 'end'

/** A short knock: a burst of filtered noise with a low thump under it, like a piece set down on wood. */
function knock(ctx: AudioContext, out: AudioNode, at: number, pitch: number, loudness: number): void {
  const length = Math.floor(ctx.sampleRate * 0.06)
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate), data = buffer.getChannelData(0)
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2
  const noise = ctx.createBufferSource()
  noise.buffer = buffer
  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'; filter.frequency.value = pitch * 4; filter.Q.value = 1.2
  const noiseGain = ctx.createGain()
  noiseGain.gain.value = loudness * 0.7
  noise.connect(filter).connect(noiseGain).connect(out)
  noise.start(at)

  const thump = ctx.createOscillator(), thumpGain = ctx.createGain()
  thump.type = 'sine'
  thump.frequency.setValueAtTime(pitch, at)
  thump.frequency.exponentialRampToValueAtTime(pitch * 0.6, at + 0.09)
  thumpGain.gain.setValueAtTime(loudness, at)
  thumpGain.gain.exponentialRampToValueAtTime(0.001, at + 0.11)
  thump.connect(thumpGain).connect(out)
  thump.start(at); thump.stop(at + 0.12)
}

function tone(ctx: AudioContext, out: AudioNode, at: number, frequency: number, seconds: number, loudness: number): void {
  const oscillator = ctx.createOscillator(), gain = ctx.createGain()
  oscillator.type = 'triangle'
  oscillator.frequency.value = frequency
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(loudness, at + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds)
  oscillator.connect(gain).connect(out)
  oscillator.start(at); oscillator.stop(at + seconds + 0.02)
}

export function playCue(cue: Cue): void {
  const bus = cueBus('effects')
  if (!bus) return
  const { ctx, out } = bus
  const at = ctx.currentTime + 0.005
  if (cue === 'move') knock(ctx, out, at, 170, 0.3)
  else if (cue === 'capture') { knock(ctx, out, at, 130, 0.38); knock(ctx, out, at + 0.07, 190, 0.26) }
  else if (cue === 'check') { knock(ctx, out, at, 170, 0.28); tone(ctx, out, at + 0.03, 660, 0.16, 0.1); tone(ctx, out, at + 0.15, 880, 0.2, 0.1) }
  else { tone(ctx, out, at, 523, 0.3, 0.1); tone(ctx, out, at + 0.14, 659, 0.3, 0.1); tone(ctx, out, at + 0.28, 784, 0.5, 0.11) }
}

/** Turn the cues on or off. Turning them on plays one, so the player hears what they chose. */
export function setSound(on: boolean): void {
  setChannelMuted('effects', !on)
  if (on) { unlockCues(); playCue('move') }
}
