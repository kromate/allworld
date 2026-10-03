import { reactive, readonly } from 'vue'
import type { RoadKind } from '../geo/district.ts'

export type AmbienceStatus = 'disabled' | 'waiting' | 'running' | 'blocked'
export type AmbienceSceneKind = 'district' | 'venue' | 'home'
export type AmbienceSourceKind = 'generator' | 'traffic' | 'motorcycle' | 'market' | 'music' | 'water'

export interface AmbienceSource {
  kind: AmbienceSourceKind
  x: number
  z: number
  gain?: number
}

export interface AmbienceListener {
  x: number
  z: number
  heading?: number
}

export interface AmbienceRegionContext {
  sources: readonly AmbienceSource[]
  listener: AmbienceListener
  hour?: number
  active?: boolean
}

export interface AmbienceEnterOptions {
  countryCode: string
  areaLabel: string
  kind: AmbienceSceneKind
  venueCategory?: string
  hour: number
  nearMajorRoad?: boolean
  rain?: boolean
}

export interface AmbienceUpdateOptions {
  playerSpeed: number
  nearRoadKind?: RoadKind
  indoors: boolean
  sources?: readonly AmbienceSource[]
  listener?: AmbienceListener
  hour?: number
}

export interface AmbienceState {
  readonly status: AmbienceStatus
  readonly volume: number
  readonly enabled: boolean
  /** A place (street, venue or home) is open, so there is something to play. */
  readonly scene: boolean
  readonly region?: string
}

interface AudioGraph {
  readonly master: GainNode
  readonly traffic: GainNode
  readonly generator: GainNode
  readonly market: GainNode
  readonly birds: GainNode
  readonly insects: GainNode
  readonly rain: GainNode
  readonly footsteps: GainNode
  readonly events: GainNode
  readonly trafficPulse: OscillatorNode
  readonly marketPulse: OscillatorNode
  readonly marketFilter: BiquadFilterNode
  readonly sources: Map<AudioScheduledSourceNode, () => void>
  spatialVoices: SpatialVoice[]
  scheduler: number | null
  nextStepAt: number
  nextHornAt: number
  nextBirdAt: number
  nextMusicAt: number
  nextTrafficShiftAt: number
  nextMarketShiftAt: number
  nextDieselRattleAt: number
  nextGeneratorPulseAt: number
  nextInsectAt: number
  nextRainTickAt: number
  nextShopBeatAt: number
  nextReligiousMotifAt: number
}

interface SpatialVoice {
  readonly input: AmbienceSource
  readonly texture: GainNode
  readonly gain: GainNode
  readonly panner: StereoPannerNode
  readonly sources: AudioScheduledSourceNode[]
}

const mutableState = reactive<{
  status: AmbienceStatus
  volume: number
  enabled: boolean
  scene: boolean
  region?: string
}>({ status: 'disabled', volume: 0.55, enabled: false, scene: false })

const state: Readonly<AmbienceState> = readonly(mutableState)
let scene: AmbienceEnterOptions | null = null
let movement: Pick<AmbienceUpdateOptions, 'playerSpeed' | 'nearRoadKind' | 'indoors'> = { playerSpeed: 0, indoors: false }
let spatialSources: AmbienceSource[] = []
let listener: AmbienceListener | null = null
let context: AudioContext | null = null
let graph: AudioGraph | null = null
let lifecycle = 0
let gestureListenersInstalled = false
let visibilityListenerInstalled = false
let manuallySuspended = false
let regionSuspended = false
let regionHeartbeatActive = false
let regionHeartbeatAt = 0
let currentRegionOwner: string | null = null
let gesturePermission = false

const clamp = (value: number, minimum = 0, maximum = 1): number => Math.min(maximum, Math.max(minimum, value))
const normalizedHour = (hour: number): number => Number.isFinite(hour) ? ((hour % 24) + 24) % 24 : 12
const isMarket = (category?: string): boolean => Boolean(category && /market|bazaar|mall|shop|retail/i.test(category))
const isKnownCountry = (countryCode: string): boolean => /^[A-Z]{2}$/.test(countryCode) && countryCode !== 'XX' && countryCode !== 'ZZ'
const worshipContext = (category?: string): 'mosque' | 'church' | 'worship' | null => {
  if (!category) return null
  if (/mosque/i.test(category)) return 'mosque'
  if (/church/i.test(category)) return 'church'
  return /place_of_worship/i.test(category) ? 'worship' : null
}
const isSuspended = (): boolean => manuallySuspended || regionSuspended
const markExpiredHeartbeat = (): boolean => {
  if (!regionHeartbeatActive || Date.now() - regionHeartbeatAt <= 750) return false
  regionSuspended = true
  return true
}

function trackSource(audioGraph: AudioGraph, source: AudioScheduledSourceNode, connectedNodes: AudioNode[] = []): void {
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    audioGraph.sources.delete(source)
    source.disconnect()
    for (const node of connectedNodes) node.disconnect()
  }
  audioGraph.sources.set(source, release)
  source.addEventListener('ended', release, { once: true })
}

function stopTrackedSource(audioGraph: AudioGraph, source: AudioScheduledSourceNode): void {
  try { source.stop() } catch { /* It already ended. */ }
  audioGraph.sources.get(source)?.()
}

function clearSpatialVoices(audioGraph: AudioGraph): void {
  for (const voice of audioGraph.spatialVoices) {
    for (const source of voice.sources) stopTrackedSource(audioGraph, source)
    voice.texture.disconnect()
    voice.gain.disconnect()
    voice.panner.disconnect()
  }
  audioGraph.spatialVoices = []
}

function stopGraph(): void {
  const current = graph
  graph = null
  if (!current) return
  if (current.scheduler !== null) window.clearInterval(current.scheduler)
  clearSpatialVoices(current)
  for (const [source, release] of current.sources) {
    try { source.stop() } catch { /* It already ended. */ }
    release()
  }
  current.sources.clear()
  current.master.disconnect()
}

function makeNoiseSource(audioContext: AudioContext, duration = 2): AudioBufferSourceNode {
  const buffer = audioContext.createBuffer(1, Math.ceil(audioContext.sampleRate * duration), audioContext.sampleRate)
  const samples = buffer.getChannelData(0)
  for (let index = 0; index < samples.length; index += 1) samples[index] = Math.random() * 2 - 1
  const source = audioContext.createBufferSource()
  source.buffer = buffer
  source.loop = true
  return source
}

function makeLayer(audioContext: AudioContext, master: AudioNode): GainNode {
  const gain = audioContext.createGain()
  gain.gain.value = 0
  gain.connect(master)
  return gain
}

function setGain(parameter: AudioParam, value: number, audioContext: AudioContext): void {
  const now = audioContext.currentTime
  parameter.cancelScheduledValues(now)
  parameter.setTargetAtTime(Math.max(0, value), now, 0.18)
}

function sourceLevel(kind: AmbienceSourceKind): number {
  switch (kind) {
    case 'generator': return 0.024
    case 'traffic': return 0.025
    case 'motorcycle': return 0.018
    case 'market': return 0.018
    case 'music': return 0.014
    case 'water': return 0.025
    default: {
      const exhaustive: never = kind
      return exhaustive
    }
  }
}

function applySpatialMix(audioContext: AudioContext, audioGraph: AudioGraph): void {
  const position = listener
  for (const voice of audioGraph.spatialVoices) {
    const dx = position ? voice.input.x - position.x : 0
    const dz = position ? voice.input.z - position.z : 0
    const distance = Math.hypot(dx, dz)
    const heading = position && Number.isFinite(position.heading) ? position.heading ?? 0 : 0
    const relative = Math.atan2(dx, dz) - heading
    const pan = position && distance > 0.01 ? Math.sin(relative) * clamp(distance / 8, 0.25, 1) : 0
    const reach = clamp(1 - distance / 120)
    const attenuation = reach / (1 + distance / 18)
    const requestedGain = clamp(voice.input.gain ?? 1, 0, 2)
    const indoor = movement.indoors ? 0.32 : 1
    setGain(voice.gain.gain, sourceLevel(voice.input.kind) * requestedGain * attenuation * indoor, audioContext)
    voice.panner.pan.setTargetAtTime(clamp(pan, -0.92, 0.92), audioContext.currentTime, 0.12)
  }
}

function addSpatialOscillator(audioContext: AudioContext, audioGraph: AudioGraph, voice: SpatialVoice, frequency: number, type: OscillatorType, cutoff?: number): void {
  const oscillator = audioContext.createOscillator()
  oscillator.type = type
  oscillator.frequency.value = frequency
  if (cutoff) {
    const filter = audioContext.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = cutoff
    oscillator.connect(filter).connect(voice.texture)
    trackSource(audioGraph, oscillator, [filter])
  } else {
    oscillator.connect(voice.texture)
    trackSource(audioGraph, oscillator)
  }
  voice.sources.push(oscillator)
  oscillator.start()
}

function addSpatialNoise(audioContext: AudioContext, audioGraph: AudioGraph, voice: SpatialVoice, type: BiquadFilterType, frequency: number, quality: number): void {
  const noise = makeNoiseSource(audioContext, 1.1)
  const filter = audioContext.createBiquadFilter()
  filter.type = type
  filter.frequency.value = frequency
  filter.Q.value = quality
  noise.connect(filter).connect(voice.texture)
  trackSource(audioGraph, noise, [filter])
  voice.sources.push(noise)
  noise.start()
}

function rebuildSpatialVoices(audioContext: AudioContext, audioGraph: AudioGraph): void {
  clearSpatialVoices(audioGraph)
  for (const input of spatialSources) {
    const texture = audioContext.createGain()
    const gain = audioContext.createGain()
    const panner = audioContext.createStereoPanner()
    texture.gain.value = 1
    gain.gain.value = 0
    texture.connect(gain).connect(panner).connect(audioGraph.master)
    const voice: SpatialVoice = { input, texture, gain, panner, sources: [] }
    audioGraph.spatialVoices.push(voice)
    switch (input.kind) {
      case 'generator':
        addSpatialOscillator(audioContext, audioGraph, voice, 48, 'sawtooth', 210)
        addSpatialOscillator(audioContext, audioGraph, voice, 96, 'triangle', 260)
        break
      case 'traffic':
        addSpatialOscillator(audioContext, audioGraph, voice, 43, 'sawtooth', 170)
        addSpatialNoise(audioContext, audioGraph, voice, 'bandpass', 310, 0.65)
        break
      case 'motorcycle':
        addSpatialOscillator(audioContext, audioGraph, voice, 108, 'sawtooth', 520)
        addSpatialOscillator(audioContext, audioGraph, voice, 216, 'square', 680)
        break
      case 'market':
        addSpatialNoise(audioContext, audioGraph, voice, 'bandpass', 760, 0.42)
        break
      case 'water':
        addSpatialNoise(audioContext, audioGraph, voice, 'bandpass', 1250, 0.28)
        break
      case 'music': break
      default: {
        const exhaustive: never = input.kind
        return exhaustive
      }
    }
  }
  applySpatialMix(audioContext, audioGraph)
}

function sameSources(left: readonly AmbienceSource[], right: readonly AmbienceSource[]): boolean {
  return left.length === right.length && left.every((source, index) => {
    const other = right[index]
    return other?.kind === source.kind && other.x === source.x && other.z === source.z && other.gain === source.gain
  })
}

function sameKindMultiset(left: readonly AmbienceSource[], right: readonly AmbienceSource[]): boolean {
  if (left.length !== right.length) return false
  const counts = new Map<AmbienceSourceKind, number>()
  for (const source of left) counts.set(source.kind, (counts.get(source.kind) ?? 0) + 1)
  for (const source of right) {
    const remaining = counts.get(source.kind) ?? 0
    if (remaining === 0) return false
    counts.set(source.kind, remaining - 1)
  }
  return [...counts.values()].every(count => count === 0)
}

function reconcileSpatialVoices(audioContext: AudioContext, audioGraph: AudioGraph, next: readonly AmbienceSource[]): boolean {
  if (!sameKindMultiset(audioGraph.spatialVoices.map(voice => voice.input), next)) return false
  const available = new Map<AmbienceSourceKind, SpatialVoice[]>()
  for (const voice of audioGraph.spatialVoices) {
    const voices = available.get(voice.input.kind)
    if (voices) voices.push(voice)
    else available.set(voice.input.kind, [voice])
  }
  const ordered: SpatialVoice[] = []
  for (const source of next) {
    const voice = available.get(source.kind)?.shift()
    if (!voice) return false
    voice.input.x = source.x
    voice.input.z = source.z
    voice.input.gain = source.gain
    ordered.push(voice)
  }
  audioGraph.spatialVoices = ordered
  applySpatialMix(audioContext, audioGraph)
  return true
}

function boundedSources(sources: readonly AmbienceSource[], position: AmbienceListener | null): AmbienceSource[] {
  return sources.filter(source => Number.isFinite(source.x) && Number.isFinite(source.z) && (source.gain === undefined || Number.isFinite(source.gain)))
    .map(source => ({ kind: source.kind, x: source.x, z: source.z, gain: source.gain === undefined ? undefined : clamp(source.gain, 0, 2) }))
    .sort((a, b) => position ? Math.hypot(a.x - position.x, a.z - position.z) - Math.hypot(b.x - position.x, b.z - position.z) : 0)
    .slice(0, 6)
}

function roadKind(): RoadKind {
  if (movement.nearRoadKind) return movement.nearRoadKind
  return scene?.nearMajorRoad ? 'major' : 'street'
}

function roadTrafficLevel(kind: RoadKind): number {
  switch (kind) {
    case 'motorway': return 0.14
    case 'major': return 0.12
    case 'street': return 0.058
    case 'service': return 0.036
    case 'rail': return 0.028
    case 'pedestrian': return 0.018
    case 'path': return 0.012
    default: {
      const exhaustive: never = kind
      return exhaustive
    }
  }
}

function footstepFrequency(kind: RoadKind): number {
  switch (kind) {
    case 'motorway':
    case 'major': return 950
    case 'street':
    case 'service':
    case 'rail': return 680
    case 'pedestrian':
    case 'path': return 430
    default: {
      const exhaustive: never = kind
      return exhaustive
    }
  }
}

function applyMix(): void {
  if (!context || !graph || !scene) return
  const hour = normalizedHour(scene.hour)
  const night = hour < 6 || hour >= 20
  const dawn = hour >= 5 && hour < 8
  const outdoors = movement.indoors || scene.kind !== 'district' ? 0.28 : 1
  const currentRoadKind = roadKind()
  const roadLevel = roadTrafficLevel(currentRoadKind)
  const residence = scene.kind === 'home' ? 0.42 : 1
  const market = isMarket(scene.venueCategory)
  const knownCountry = isKnownCountry(scene.countryCode.toUpperCase())
  const nigeria = scene.countryCode.toUpperCase() === 'NG'
  const masterLevel = mutableState.volume * (movement.indoors ? 0.72 : 1)

  setGain(graph.master.gain, masterLevel, context)
  setGain(graph.traffic.gain, roadLevel * outdoors * residence * (night ? 0.62 : 1), context)
  const generatorLevel = market ? 0.018 : currentRoadKind === 'motorway' || currentRoadKind === 'major' ? 0.011 : 0.006
  setGain(graph.generator.gain, nigeria && (market || scene.kind === 'district') ? generatorLevel * outdoors : 0, context)
  setGain(graph.market.gain, knownCountry && market ? 0.022 * (movement.indoors ? 0.65 : 1) : 0, context)
  setGain(graph.birds.gain, dawn ? 0.055 * outdoors : night ? 0 : 0.012 * outdoors, context)
  setGain(graph.insects.gain, night ? 0.026 * outdoors : 0, context)
  setGain(graph.rain.gain, scene.rain ? 0.055 * (movement.indoors ? 0.45 : 1) : 0, context)
  setGain(graph.footsteps.gain, movement.playerSpeed > 0.12 ? 0.075 * (movement.indoors ? 0.55 : 1) : 0, context)
  setGain(graph.events.gain, movement.indoors ? 0.18 : 1, context)
  applySpatialMix(context, graph)
}

function playTone(audioContext: AudioContext, audioGraph: AudioGraph, options: {
  at: number
  duration: number
  frequency: number
  endFrequency?: number
  gain: number
  destination: AudioNode
  type?: OscillatorType
}): void {
  const oscillator = audioContext.createOscillator()
  const envelope = audioContext.createGain()
  oscillator.type = options.type ?? 'sine'
  oscillator.frequency.setValueAtTime(options.frequency, options.at)
  if (options.endFrequency) oscillator.frequency.exponentialRampToValueAtTime(options.endFrequency, options.at + options.duration)
  envelope.gain.setValueAtTime(0.0001, options.at)
  envelope.gain.exponentialRampToValueAtTime(options.gain, options.at + Math.min(0.03, options.duration / 4))
  envelope.gain.exponentialRampToValueAtTime(0.0001, options.at + options.duration)
  oscillator.connect(envelope).connect(options.destination)
  trackSource(audioGraph, oscillator, [envelope])
  oscillator.start(options.at)
  oscillator.stop(options.at + options.duration + 0.02)
}

function playNoiseBurst(audioContext: AudioContext, audioGraph: AudioGraph, options: {
  at: number
  duration: number
  frequency: number
  quality: number
  gain: number
  destination: AudioNode
}): void {
  const source = audioContext.createBufferSource()
  const buffer = audioContext.createBuffer(1, Math.ceil(audioContext.sampleRate * options.duration), audioContext.sampleRate)
  const data = buffer.getChannelData(0)
  for (let index = 0; index < data.length; index += 1) data[index] = (Math.random() * 2 - 1) * (1 - index / data.length)
  const filter = audioContext.createBiquadFilter()
  const envelope = audioContext.createGain()
  filter.type = 'bandpass'
  filter.frequency.value = options.frequency
  filter.Q.value = options.quality
  envelope.gain.setValueAtTime(0.0001, options.at)
  envelope.gain.exponentialRampToValueAtTime(options.gain, options.at + Math.min(0.008, options.duration / 3))
  envelope.gain.exponentialRampToValueAtTime(0.0001, options.at + options.duration)
  source.buffer = buffer
  source.connect(filter).connect(envelope).connect(options.destination)
  trackSource(audioGraph, source, [filter, envelope])
  source.start(options.at)
}

function spatialVoice(audioGraph: AudioGraph, kind: AmbienceSourceKind): SpatialVoice | undefined {
  return audioGraph.spatialVoices.find(voice => voice.input.kind === kind)
}

function scheduleStep(audioContext: AudioContext, audioGraph: AudioGraph, at: number): void {
  const source = audioContext.createBufferSource()
  const buffer = audioContext.createBuffer(1, Math.ceil(audioContext.sampleRate * 0.055), audioContext.sampleRate)
  const data = buffer.getChannelData(0)
  for (let index = 0; index < data.length; index += 1) data[index] = (Math.random() * 2 - 1) * (1 - index / data.length)
  const filter = audioContext.createBiquadFilter()
  const envelope = audioContext.createGain()
  filter.type = 'bandpass'
  filter.frequency.value = footstepFrequency(roadKind())
  filter.Q.value = 0.8
  envelope.gain.setValueAtTime(0.0001, at)
  envelope.gain.exponentialRampToValueAtTime(0.75, at + 0.008)
  envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.055)
  source.buffer = buffer
  source.connect(filter).connect(envelope).connect(audioGraph.footsteps)
  trackSource(audioGraph, source, [filter, envelope])
  source.start(at)
}

function runScheduler(audioContext: AudioContext, audioGraph: AudioGraph): void {
  if (graph !== audioGraph || audioContext.state !== 'running' || !scene) return
  if (markExpiredHeartbeat()) {
    void suspendAudio('waiting')
    return
  }
  const now = audioContext.currentTime
  const hour = normalizedHour(scene.hour)
  const outdoors = !movement.indoors && scene.kind === 'district'
  const nigeria = scene.countryCode === 'NG'
  const trafficVoice = spatialVoice(audioGraph, 'traffic')
  const generatorVoice = spatialVoice(audioGraph, 'generator')
  const musicVoice = spatialVoice(audioGraph, 'music')

  if (movement.playerSpeed > 0.12 && now >= audioGraph.nextStepAt) {
    scheduleStep(audioContext, audioGraph, now + 0.02)
    audioGraph.nextStepAt = now + clamp(0.62 - movement.playerSpeed * 0.075, 0.24, 0.58)
  }
  if (outdoors && (trafficVoice || roadKind() === 'motorway' || roadKind() === 'major') && now >= audioGraph.nextHornAt) {
    if (Math.random() < 0.32) {
      const destination = trafficVoice?.gain ?? audioGraph.events
      const gain = trafficVoice ? 0.42 : 0.026
      playTone(audioContext, audioGraph, { at: now + 0.03, duration: 0.12, frequency: nigeria ? 335 : 390, endFrequency: nigeria ? 310 : 345, gain, destination, type: 'square' })
      if (nigeria) playTone(audioContext, audioGraph, { at: now + 0.22, duration: 0.1, frequency: 365, endFrequency: 330, gain: gain * 0.82, destination, type: 'square' })
    }
    audioGraph.nextHornAt = now + 6 + Math.random() * 14
  }
  if (nigeria && outdoors && now >= audioGraph.nextDieselRattleAt) {
    const destination = trafficVoice?.gain ?? audioGraph.traffic
    playNoiseBurst(audioContext, audioGraph, { at: now + 0.02, duration: 0.055, frequency: 260 + Math.random() * 120, quality: 1.8, gain: trafficVoice ? 0.22 : 0.018, destination })
    audioGraph.nextDieselRattleAt = now + 1.8 + Math.random() * 4.2
  }
  if (now >= audioGraph.nextGeneratorPulseAt && (generatorVoice || (nigeria && outdoors))) {
    const destination = generatorVoice?.gain ?? audioGraph.generator
    playTone(audioContext, audioGraph, { at: now + 0.02, duration: 0.07, frequency: 72, endFrequency: 56, gain: generatorVoice ? 0.24 : 0.012, destination, type: 'sawtooth' })
    audioGraph.nextGeneratorPulseAt = now + 0.72 + Math.random() * 0.46
  }
  if (outdoors && hour >= 5 && hour < 8 && now >= audioGraph.nextBirdAt) {
    const start = now + 0.03
    playTone(audioContext, audioGraph, { at: start, duration: 0.09, frequency: 1650, endFrequency: 2350, gain: 0.032, destination: audioGraph.birds })
    playTone(audioContext, audioGraph, { at: start + 0.12, duration: 0.08, frequency: 2050, endFrequency: 2750, gain: 0.022, destination: audioGraph.birds })
    audioGraph.nextBirdAt = now + 2.8 + Math.random() * 7
  }
  if (outdoors && (hour < 6 || hour >= 20) && now >= audioGraph.nextInsectAt) {
    const start = now + 0.02
    playTone(audioContext, audioGraph, { at: start, duration: 0.035, frequency: 3150, endFrequency: 3520, gain: 0.025, destination: audioGraph.insects })
    playTone(audioContext, audioGraph, { at: start + 0.065, duration: 0.03, frequency: 3300, endFrequency: 3680, gain: 0.02, destination: audioGraph.insects })
    audioGraph.nextInsectAt = now + 0.6 + Math.random() * 2.4
  }
  if (scene.rain && now >= audioGraph.nextRainTickAt) {
    const start = now + 0.02
    playNoiseBurst(audioContext, audioGraph, { at: start, duration: 0.025, frequency: 2600 + Math.random() * 1800, quality: 3.2, gain: 0.045, destination: audioGraph.rain })
    if (Math.random() < 0.28) playTone(audioContext, audioGraph, { at: start, duration: 0.08, frequency: 540 + Math.random() * 240, endFrequency: 470, gain: 0.012, destination: audioGraph.rain, type: 'triangle' })
    audioGraph.nextRainTickAt = now + 0.12 + Math.random() * 0.48
  }
  if (isKnownCountry(scene.countryCode.toUpperCase()) && isMarket(scene.venueCategory) && now >= audioGraph.nextMusicAt) {
    const notes = [220, 247, 294, 330, 370]
    const note = notes[Math.floor(Math.random() * notes.length)] ?? 220
    playTone(audioContext, audioGraph, { at: now + 0.03, duration: 0.7, frequency: note, gain: 0.012, destination: audioGraph.events, type: 'triangle' })
    audioGraph.nextMusicAt = now + 2.5 + Math.random() * 4
  }
  if ((musicVoice || isMarket(scene.venueCategory)) && now >= audioGraph.nextShopBeatAt) {
    const destination = musicVoice?.gain ?? audioGraph.events
    const gain = musicVoice ? 0.34 : 0.011
    const start = now + 0.02
    playTone(audioContext, audioGraph, { at: start, duration: 0.065, frequency: 132, endFrequency: 108, gain, destination, type: 'triangle' })
    playTone(audioContext, audioGraph, { at: start + 0.21, duration: 0.045, frequency: 210, endFrequency: 175, gain: gain * 0.72, destination, type: 'square' })
    playTone(audioContext, audioGraph, { at: start + 0.43, duration: 0.055, frequency: 165, endFrequency: 132, gain: gain * 0.82, destination, type: 'triangle' })
    audioGraph.nextShopBeatAt = now + 1.7 + Math.random() * 1.6
  }
  const worship = worshipContext(scene.venueCategory)
  const worshipHour = worship === 'mosque' ? (hour >= 4.5 && hour <= 6.5) || (hour >= 11.5 && hour <= 14.5) || (hour >= 17 && hour <= 20.5)
    : worship === 'church' ? (hour >= 7 && hour <= 12.5) || (hour >= 17 && hour <= 20)
      : worship === 'worship' ? hour >= 8 && hour <= 19 : false
  if (worshipHour && now >= audioGraph.nextReligiousMotifAt) {
    const start = now + 0.03
    const notes = worship === 'mosque' ? [262, 311, 349] : worship === 'church' ? [247, 294, 330] : [262, 294, 330]
    notes.forEach((frequency, index) => playTone(audioContext, audioGraph, { at: start + index * 0.32, duration: 0.38, frequency, gain: 0.007, destination: audioGraph.events, type: 'sine' }))
    audioGraph.nextReligiousMotifAt = now + 24 + Math.random() * 32
  }
  if (now >= audioGraph.nextTrafficShiftAt) {
    audioGraph.trafficPulse.frequency.setTargetAtTime(0.045 + Math.random() * 0.075, now, 1.8)
    audioGraph.nextTrafficShiftAt = now + 7 + Math.random() * 11
  }
  if (now >= audioGraph.nextMarketShiftAt) {
    audioGraph.marketPulse.frequency.setTargetAtTime(0.38 + Math.random() * 0.52, now, 0.45)
    audioGraph.marketFilter.frequency.setTargetAtTime(480 + Math.random() * 520, now, 0.32)
    audioGraph.marketFilter.Q.setTargetAtTime(0.28 + Math.random() * 0.36, now, 0.32)
    for (const voice of audioGraph.spatialVoices) {
      if (voice.input.kind === 'market') voice.texture.gain.setTargetAtTime(0.52 + Math.random() * 0.46, now, 0.18)
    }
    audioGraph.nextMarketShiftAt = now + 0.7 + Math.random() * 1.4
  }
}

function buildGraph(audioContext: AudioContext): void {
  stopGraph()
  if (!scene || audioContext.state !== 'running') return

  const master = audioContext.createGain()
  master.gain.value = 0
  master.connect(audioContext.destination)
  const trafficPulse = audioContext.createOscillator()
  const marketPulse = audioContext.createOscillator()
  const marketFilter = audioContext.createBiquadFilter()
  const audioGraph: AudioGraph = {
    master,
    traffic: makeLayer(audioContext, master),
    generator: makeLayer(audioContext, master),
    market: makeLayer(audioContext, master),
    birds: makeLayer(audioContext, master),
    insects: makeLayer(audioContext, master),
    rain: makeLayer(audioContext, master),
    footsteps: makeLayer(audioContext, master),
    events: makeLayer(audioContext, master),
    trafficPulse,
    marketPulse,
    marketFilter,
    sources: new Map(),
    spatialVoices: [],
    scheduler: null,
    nextStepAt: audioContext.currentTime,
    nextHornAt: audioContext.currentTime + 4,
    nextBirdAt: audioContext.currentTime + 1,
    nextMusicAt: audioContext.currentTime + 1.5,
    nextTrafficShiftAt: audioContext.currentTime + 5,
    nextMarketShiftAt: audioContext.currentTime + 0.8,
    nextDieselRattleAt: audioContext.currentTime + 1.2,
    nextGeneratorPulseAt: audioContext.currentTime + 0.6,
    nextInsectAt: audioContext.currentTime + 0.5,
    nextRainTickAt: audioContext.currentTime + 0.15,
    nextShopBeatAt: audioContext.currentTime + 0.7,
    nextReligiousMotifAt: audioContext.currentTime + 8,
  }
  graph = audioGraph

  const trafficNoise = makeNoiseSource(audioContext)
  const trafficFilter = audioContext.createBiquadFilter()
  trafficFilter.type = 'lowpass'
  trafficFilter.frequency.value = 520
  trafficFilter.Q.value = 0.55
  const trafficMotion = audioContext.createGain()
  const trafficPulseDepth = audioContext.createGain()
  trafficMotion.gain.value = 0.74
  trafficPulse.type = 'sine'
  trafficPulse.frequency.value = 0.075
  trafficPulseDepth.gain.value = 0.22
  trafficPulse.connect(trafficPulseDepth).connect(trafficMotion.gain)
  trafficNoise.connect(trafficFilter).connect(trafficMotion).connect(audioGraph.traffic)
  trackSource(audioGraph, trafficNoise, [trafficFilter])
  trackSource(audioGraph, trafficPulse, [trafficPulseDepth, trafficMotion])
  trafficNoise.start()
  trafficPulse.start()

  if (scene.countryCode === 'NG') {
    const diesel = audioContext.createOscillator()
    const dieselFilter = audioContext.createBiquadFilter()
    const dieselLevel = audioContext.createGain()
    diesel.type = 'sawtooth'
    diesel.frequency.value = 44
    dieselFilter.type = 'lowpass'
    dieselFilter.frequency.value = 150
    dieselLevel.gain.value = 0.1
    diesel.connect(dieselFilter).connect(dieselLevel).connect(audioGraph.traffic)
    trackSource(audioGraph, diesel, [dieselFilter, dieselLevel])
    diesel.start()
  }

  const generatorLow = audioContext.createOscillator()
  const generatorHigh = audioContext.createOscillator()
  generatorLow.type = 'sawtooth'
  generatorLow.frequency.value = 49
  generatorHigh.type = 'triangle'
  generatorHigh.frequency.value = 98
  generatorLow.connect(audioGraph.generator)
  generatorHigh.connect(audioGraph.generator)
  trackSource(audioGraph, generatorLow)
  trackSource(audioGraph, generatorHigh)
  generatorLow.start()
  generatorHigh.start()

  const marketNoise = makeNoiseSource(audioContext, 1.4)
  marketFilter.type = 'bandpass'
  marketFilter.frequency.value = 720
  marketFilter.Q.value = 0.38
  const marketMotion = audioContext.createGain()
  const marketPulseDepth = audioContext.createGain()
  marketMotion.gain.value = 0.68
  marketPulse.type = 'sine'
  marketPulse.frequency.value = 0.56
  marketPulseDepth.gain.value = 0.18
  marketPulse.connect(marketPulseDepth).connect(marketMotion.gain)
  marketNoise.connect(marketFilter).connect(marketMotion).connect(audioGraph.market)
  trackSource(audioGraph, marketNoise, [marketFilter])
  trackSource(audioGraph, marketPulse, [marketPulseDepth, marketMotion])
  marketNoise.start()
  marketPulse.start()

  const rainNoise = makeNoiseSource(audioContext, 1.3)
  const rainFilter = audioContext.createBiquadFilter()
  rainFilter.type = 'highpass'
  rainFilter.frequency.value = 1450
  rainNoise.connect(rainFilter).connect(audioGraph.rain)
  trackSource(audioGraph, rainNoise, [rainFilter])
  rainNoise.start()

  rebuildSpatialVoices(audioContext, audioGraph)

  audioGraph.scheduler = window.setInterval(() => runScheduler(audioContext, audioGraph), 180)
  applyMix()
  mutableState.status = 'running'
}

function installGestureListeners(): void {
  if (gestureListenersInstalled || typeof window === 'undefined') return
  window.addEventListener('pointerdown', onTrustedGesture, { capture: true })
  window.addEventListener('keydown', onTrustedGesture, { capture: true })
  gestureListenersInstalled = true
}

function removeGestureListeners(): void {
  if (!gestureListenersInstalled || typeof window === 'undefined') return
  window.removeEventListener('pointerdown', onTrustedGesture, { capture: true })
  window.removeEventListener('keydown', onTrustedGesture, { capture: true })
  gestureListenersInstalled = false
}

async function startFromTrustedGesture(): Promise<void> {
  if (markExpiredHeartbeat()) {
    mutableState.status = 'waiting'
    removeGestureListeners()
    return
  }
  if (!mutableState.enabled || isSuspended() || (typeof document !== 'undefined' && document.hidden)) return
  if (!scene) {
    mutableState.status = 'waiting'
    return
  }
  if (typeof AudioContext === 'undefined') {
    mutableState.status = 'blocked'
    removeGestureListeners()
    return
  }
  const attempt = ++lifecycle
  let localContext = context
  try {
    if (!localContext || localContext.state === 'closed') {
      localContext = new AudioContext({ latencyHint: 'playback' })
      context = localContext
    }
    if (localContext.state !== 'running') await localContext.resume()
    if (attempt !== lifecycle || context !== localContext || !mutableState.enabled || isSuspended() || document.hidden || !scene) {
      if (context !== localContext && localContext.state !== 'closed') await localContext.close().catch(() => undefined)
      return
    }
    gesturePermission = true
    removeGestureListeners()
    buildGraph(localContext)
  } catch {
    if (context !== localContext && localContext?.state !== 'closed') await localContext?.close().catch(() => undefined)
    if (attempt === lifecycle && context === localContext && mutableState.enabled && !isSuspended() && scene && !document.hidden) {
      stopGraph()
      mutableState.status = 'blocked'
      installGestureListeners()
    }
  }
}

function onTrustedGesture(event: Event): void {
  if (!event.isTrusted) return
  void startFromTrustedGesture()
}

async function suspendAudio(status: AmbienceStatus): Promise<void> {
  ++lifecycle
  stopGraph()
  const current = context
  mutableState.status = status
  if (current && current.state !== 'closed') await current.suspend().catch(() => undefined)
}

function onVisibilityChange(): void {
  if (document.hidden) {
    void suspendAudio(mutableState.enabled ? 'waiting' : 'disabled')
    removeGestureListeners()
    return
  }
  if (markExpiredHeartbeat()) {
    mutableState.status = 'waiting'
    return
  }
  if (mutableState.enabled && scene && !isSuspended()) {
    mutableState.status = 'waiting'
    installGestureListeners()
  }
}

async function resumeWithPermission(): Promise<void> {
  if (markExpiredHeartbeat()) {
    mutableState.status = 'waiting'
    return
  }
  const localContext = context
  if (!gesturePermission || !localContext || localContext.state === 'closed' || !mutableState.enabled || isSuspended() || !scene || document.hidden) {
    if (mutableState.enabled) mutableState.status = 'waiting'
    if (!isSuspended() && !document.hidden) installGestureListeners()
    return
  }
  const attempt = ++lifecycle
  try {
    if (localContext.state !== 'running') await localContext.resume()
    if (attempt !== lifecycle || context !== localContext || !mutableState.enabled || isSuspended() || !scene || document.hidden) return
    removeGestureListeners()
    buildGraph(localContext)
  } catch {
    if (attempt === lifecycle && context === localContext && mutableState.enabled && !isSuspended() && scene && !document.hidden) {
      mutableState.status = 'waiting'
      installGestureListeners()
    }
  }
}

function installVisibilityListener(): void {
  if (visibilityListenerInstalled || typeof document === 'undefined') return
  document.addEventListener('visibilitychange', onVisibilityChange)
  visibilityListenerInstalled = true
}

function removeVisibilityListener(): void {
  if (!visibilityListenerInstalled || typeof document === 'undefined') return
  document.removeEventListener('visibilitychange', onVisibilityChange)
  visibilityListenerInstalled = false
}

function enter(options: AmbienceEnterOptions): void {
  scene = {
    ...options,
    countryCode: options.countryCode.trim().toUpperCase(),
    hour: normalizedHour(options.hour),
    rain: options.rain ?? false,
  }
  mutableState.region = scene.countryCode || undefined
  mutableState.scene = true
  movement = { playerSpeed: 0, indoors: scene.kind !== 'district' }
  spatialSources = []
  listener = null
  regionHeartbeatActive = false
  regionHeartbeatAt = 0
  regionSuspended = false
  currentRegionOwner = null
  if (!mutableState.enabled) return
  installVisibilityListener()
  if (context?.state === 'running' && mutableState.status === 'running' && !document.hidden && !isSuspended()) buildGraph(context)
  else {
    mutableState.status = 'waiting'
    if (!isSuspended()) installGestureListeners()
    if (gesturePermission && context && context.state !== 'closed' && !document.hidden && !isSuspended()) void resumeWithPermission()
  }
}

function update(options: AmbienceUpdateOptions): void {
  movement = {
    playerSpeed: Math.max(0, Number.isFinite(options.playerSpeed) ? options.playerSpeed : 0),
    nearRoadKind: options.nearRoadKind,
    indoors: options.indoors,
  }
  if (options.listener && Number.isFinite(options.listener.x) && Number.isFinite(options.listener.z)) {
    listener = {
      x: options.listener.x,
      z: options.listener.z,
      heading: Number.isFinite(options.listener.heading) ? options.listener.heading : undefined,
    }
  }
  if (scene && options.hour !== undefined) scene = { ...scene, hour: normalizedHour(options.hour) }
  if (options.sources !== undefined) {
    const nextSources = boundedSources(options.sources, listener)
    if (!sameSources(spatialSources, nextSources)) {
      spatialSources = nextSources
      if (context && graph && context.state === 'running' && !reconcileSpatialVoices(context, graph, nextSources)) rebuildSpatialVoices(context, graph)
    }
  }
  applyMix()
}

function leave(): void {
  scene = null
  spatialSources = []
  listener = null
  regionHeartbeatActive = false
  regionHeartbeatAt = 0
  regionSuspended = false
  currentRegionOwner = null
  mutableState.region = undefined
  mutableState.scene = false
  removeGestureListeners()
  removeVisibilityListener()
  void suspendAudio(mutableState.enabled ? 'waiting' : 'disabled')
}

function setVolume(volume: number): void {
  mutableState.volume = clamp(Number.isFinite(volume) ? volume : 0)
  applyMix()
}

function setEnabled(enabled: boolean): void {
  if (enabled === mutableState.enabled) return
  mutableState.enabled = enabled
  if (!enabled) {
    removeGestureListeners()
    removeVisibilityListener()
    ++lifecycle
    stopGraph()
    mutableState.status = 'disabled'
    const closing = context
    context = null
    gesturePermission = false
    if (closing && closing.state !== 'closed') void closing.close().catch(() => undefined)
    return
  }

  mutableState.status = 'waiting'
  installVisibilityListener()
  if (isSuspended()) return
  if (scene && typeof navigator !== 'undefined' && navigator.userActivation?.isActive) void startFromTrustedGesture()
  else installGestureListeners()
}

function setSuspended(suspended: boolean): void {
  if (manuallySuspended === suspended) return
  manuallySuspended = suspended
  if (suspended) {
    removeGestureListeners()
    void suspendAudio(mutableState.enabled ? 'waiting' : 'disabled')
    return
  }
  if (markExpiredHeartbeat()) {
    mutableState.status = mutableState.enabled ? 'waiting' : 'disabled'
    return
  }
  if (!mutableState.enabled || !scene || document.hidden) {
    mutableState.status = mutableState.enabled ? 'waiting' : 'disabled'
    return
  }
  installVisibilityListener()
  void resumeWithPermission()
}

function setRegionSuspended(suspended: boolean): void {
  if (regionSuspended === suspended) return
  regionSuspended = suspended
  if (suspended) {
    removeGestureListeners()
    void suspendAudio(mutableState.enabled ? 'waiting' : 'disabled')
    return
  }
  if (manuallySuspended || !mutableState.enabled || !scene || document.hidden) {
    mutableState.status = mutableState.enabled ? 'waiting' : 'disabled'
    return
  }
  installVisibilityListener()
  void resumeWithPermission()
}

function setRegionContext(next: AmbienceRegionContext | null, owner?: string): void {
  if (!next) {
    if (owner !== undefined && owner !== currentRegionOwner) return
    currentRegionOwner = null
    regionHeartbeatActive = false
    regionHeartbeatAt = 0
    listener = null
    update({ playerSpeed: movement.playerSpeed, nearRoadKind: movement.nearRoadKind, indoors: movement.indoors, sources: [] })
    setRegionSuspended(false)
    return
  }

  currentRegionOwner = owner ?? null
  const active = next.active ?? true
  regionHeartbeatActive = active
  regionHeartbeatAt = Date.now()
  if (!active) setRegionSuspended(true)
  update({
    playerSpeed: movement.playerSpeed,
    nearRoadKind: movement.nearRoadKind,
    indoors: movement.indoors,
    sources: next.sources,
    listener: next.listener,
    hour: next.hour,
  })
  if (active) setRegionSuspended(false)
}

export const ambience = Object.freeze({ state, enter, update, leave, setVolume, setEnabled, setSuspended, setRegionContext })
