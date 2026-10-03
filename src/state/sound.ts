// Sound: the member's choices, kept on this device, and the one place every sound in the App asks
// "how loud, and is it muted?". Six channels — master, music, ambience, effects, ui, voice — each
// with a volume and a mute. Master scales everything the member HEARS; it never touches the
// microphone, which is controlled only by Voice → Mute (src/platform/voice.ts).
//
// Who listens to which channel:
//   ambience  src/world/ambience.ts (street sound, driven from here)
//   effects   board cues in chess, Word Yard and Ten Walls (via cueBus)
//   ui        game-hall alerts in src/features/arena/arenaSound.ts (via cueBus)
//   voice     the audio of people in range, in src/platform/voice.ts
//   music     nothing: no music ships in this build, so the channel is marked unavailable.
// Everything is made in the App with WebAudio; there are no sound files.
//
// Ambience and the cues are silent until the member turns them on, and browsers only start audio
// from a tap or key press, so call the setters from one.
import { reactive, watch } from 'vue'
import { ambience } from '../world/ambience.ts'

export type SoundChannel = 'master' | 'music' | 'ambience' | 'effects' | 'ui' | 'voice'
export type CueChannel = 'effects' | 'ui'
interface ChannelState { volume: number; muted: boolean }

export const CHANNEL_INFO: readonly { channel: SoundChannel; label: string; available: boolean }[] = [
  { channel: 'master', label: 'Master', available: true },
  { channel: 'music', label: 'Music', available: false },
  { channel: 'ambience', label: 'Street sound', available: true },
  { channel: 'effects', label: 'Game sounds', available: true },
  { channel: 'ui', label: 'Hall alerts', available: true },
  { channel: 'voice', label: 'Voices you hear', available: true },
]

// Ambience and the cues start off, as they always did; master, music and voice start on.
const DEFAULTS: Record<SoundChannel, ChannelState> = {
  master: { volume: 1, muted: false },
  music: { volume: 1, muted: false },
  ambience: { volume: 0.55, muted: true },
  effects: { volume: 1, muted: true },
  ui: { volume: 1, muted: true },
  voice: { volume: 1, muted: false },
}

const KEY = 'nw.sound.v2'
const read = (key: string): string | null => { try { return localStorage.getItem(key) } catch { return null } }
const level = (value: unknown, fallback: number): number => typeof value === 'number' && value >= 0 && value <= 1 ? value : fallback

function load(): Record<SoundChannel, ChannelState> {
  const out = Object.fromEntries(CHANNEL_INFO.map(({ channel }) => [channel, { ...DEFAULTS[channel] }])) as Record<SoundChannel, ChannelState>
  try {
    const raw = JSON.parse(read(KEY) ?? 'null') as Partial<Record<SoundChannel, Partial<ChannelState>>> | null
    if (raw && typeof raw === 'object') {
      for (const { channel } of CHANNEL_INFO) {
        out[channel].volume = level(raw[channel]?.volume, out[channel].volume)
        if (typeof raw[channel]?.muted === 'boolean') out[channel].muted = raw[channel]!.muted!
      }
      return out
    }
  } catch { /* unreadable: fall through to the older keys */ }
  // First run of this version: carry over what the member chose before. The old keys are left alone.
  try {
    const street = JSON.parse(read('nw.sound') ?? 'null') as { enabled?: unknown; volume?: unknown } | null
    if (street) { out.ambience.volume = level(street.volume, out.ambience.volume); out.ambience.muted = street.enabled !== true }
  } catch { /* nothing to carry over */ }
  out.ui.muted = read('nw.arena.sound') !== '1'
  out.effects.muted = !(read('nw.arena.chess.sound') === 'on' || read('nw.words.sound') === 'on' || read('nw.tenwalls.sound') === '1')
  return out
}

export const channels = reactive(load())
export const soundStatus = ambience.state

function keep(): void { try { localStorage.setItem(KEY, JSON.stringify(channels)) } catch { /* private mode: the choice lasts for this visit */ } }

/** How loud a channel actually is, 0 to 1: its own volume times master, and 0 if either is muted. */
export function channelLevel(channel: SoundChannel): number {
  const own = channels[channel]
  if (own.muted) return 0
  if (channel === 'master') return own.volume
  return channels.master.muted ? 0 : channels.master.volume * own.volume
}

export function setChannelVolume(channel: SoundChannel, volume: number): void {
  channels[channel].volume = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 0))
  keep()
}
/** Call from a tap or key press: that is what lets the browser start audio. */
export function setChannelMuted(channel: SoundChannel, muted: boolean): void {
  channels[channel].muted = muted
  keep()
}

/** One honest line about where a channel stands, for the pages that show it. */
export function channelNote(channel: SoundChannel): string {
  const silenced = channel !== 'master' && channel !== 'music' && channels.master.muted && !channels[channel].muted
  switch (channel) {
    case 'master': return channels.master.muted ? 'Off: you hear nothing from the App. Your microphone is not changed by this.' : 'How loud everything you hear is. It does not change your microphone.'
    case 'music': return 'There is no music in this build yet, so there is nothing to turn up.'
    case 'ambience': {
      if (channels.ambience.muted) return 'Off. Traffic, generators, markets, footsteps and weather for the place you are in. Made in the App, not recorded on location.'
      if (silenced) return 'Silenced while Master is off.'
      if (soundStatus.status === 'blocked') return 'This browser would not start audio.'
      if (soundStatus.status === 'running') return 'Playing.'
      return soundStatus.scene ? 'Starts with your next tap or key press, once the world view is in front.' : 'Plays in a street, venue or home. None is open right now.'
    }
    case 'effects': return silenced ? 'Silenced while Master is off.' : 'Short sounds for moves in Chess, Word Yard and Ten Walls.'
    case 'ui': return silenced ? 'Silenced while Master is off.' : 'Game hall alerts: your turn, low time, chat, offers and the end of a game.'
    case 'voice': return silenced ? 'Silenced while Master is off. Your microphone is separate: use Mute next to Voice in nearby chat.' : 'People within range when you are on voice. Your microphone is separate: use Mute next to Voice in nearby chat.'
  }
}

/** Whether this browser lets a page set the volume of an audio element. Some phones fix it at full, so only mute works. */
export const voiceVolumeAdjustable: boolean = (() => {
  try { const probe = new Audio(); probe.volume = 0.5; return probe.volume === 0.5 } catch { return true }
})()

// ── Short cues ──
// Chess, Word Yard, Ten Walls and the hall share one AudioContext and one gain per channel, so
// master and mute apply to a cue already playing, and a hidden page makes no sound.
let cueContext: AudioContext | null = null
const buses = new Map<CueChannel, GainNode>()

function closeCues(): void {
  const closing = cueContext
  cueContext = null
  buses.clear()
  if (closing && closing.state !== 'closed') void closing.close().catch(() => undefined)
}

/** Where a short cue should play: the shared context and the channel's gain, or null if it must stay silent now. */
export function cueBus(channel: CueChannel): { ctx: AudioContext; out: AudioNode } | null {
  if (document.hidden || channelLevel(channel) === 0) return null
  if (!cueContext || cueContext.state === 'closed') {
    if (typeof AudioContext === 'undefined') return null
    try { cueContext = new AudioContext(); buses.clear() } catch { cueContext = null; return null }
  }
  const ctx = cueContext
  // Not unlocked yet (or interrupted): ask once more and skip this cue rather than let it queue.
  if (ctx.state !== 'running') { void ctx.resume().catch(() => undefined); return null }
  let out = buses.get(channel)
  // A bus already in the map is being steered by apply(); setting its gain here would cut a fade short.
  if (!out) { out = ctx.createGain(); out.gain.value = channelLevel(channel); out.connect(ctx.destination); buses.set(channel, out) }
  return { ctx, out }
}

/** Call from a tap or key press so the browser allows cues afterwards. */
export function unlockCues(): void {
  if (channelLevel('effects') === 0 && channelLevel('ui') === 0) return
  if (!cueContext || cueContext.state === 'closed') {
    if (typeof AudioContext === 'undefined') return
    try { cueContext = new AudioContext(); buses.clear() } catch { cueContext = null; return }
  }
  if (cueContext.state !== 'running') void cueContext.resume().catch(() => undefined)
}

/** Two soft notes, so a member can hear what a cue channel sounds like at the level they set. */
export function playTestCue(channel: CueChannel): void {
  unlockCues()
  const bus = cueBus(channel)
  if (!bus) return
  const { ctx, out } = bus
  for (const [at, hz] of [[0, 523], [0.14, 659]] as const) {
    const start = ctx.currentTime + 0.01 + at
    const tone = ctx.createOscillator(), gain = ctx.createGain()
    tone.type = 'triangle'
    tone.frequency.setValueAtTime(hz, start)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(0.14, start + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16)
    tone.connect(gain).connect(out)
    tone.onended = () => { tone.disconnect(); gain.disconnect() }
    tone.start(start)
    tone.stop(start + 0.18)
  }
}

// A hidden page makes no cue sound; coming back lets the next cue ask for the context again.
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
  const ctx = cueContext
  if (!ctx || ctx.state === 'closed') return
  if (document.hidden) void ctx.suspend().catch(() => undefined)
  else void ctx.resume().catch(() => undefined)
})

const BUS_RAMP = 0.02

/** Fade a bus to a level from wherever it is now. A target ramp only approaches its level, so silence is landed exactly. */
function steerBus(bus: GainNode, level: number): void {
  const now = bus.context.currentTime
  bus.gain.cancelScheduledValues(now)
  bus.gain.setTargetAtTime(level, now, BUS_RAMP)
  if (level === 0) bus.gain.setValueAtTime(0, now + BUS_RAMP * 8)
}

// Every change to a channel lands here: ambience follows its channel,
// cue buses follow theirs, and the cue context is let go when neither cue channel can be heard.
function apply(): void {
  ambience.setVolume(channelLevel('ambience'))
  ambience.setEnabled(!channels.master.muted && !channels.ambience.muted)
  for (const [channel, bus] of buses) steerBus(bus, channelLevel(channel))
  if (cueContext && channelLevel('effects') === 0 && channelLevel('ui') === 0) closeCues()
}
watch(channels, apply, { deep: true, flush: 'sync' })

// A saved "on" waits for the member's next tap; nothing plays before that.
apply()

export { ambience }
