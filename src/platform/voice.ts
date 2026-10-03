// Proximity voice: peer-to-peer audio between avatars the service counts as in range.
//
// The service decides the audience (same room, within the proximity radius, no block either
// way) and only relays signalling between those peers. This module opens and closes
// connections as that list changes and fades each voice with virtual distance.
//
// What the member hears follows the shared sound channels (src/state/sound.ts): the voice
// channel and master scale or silence every incoming voice. That is hearing only. The microphone
// is switched on and off by setVoice below and by nothing else, so silencing voices does not stop
// the member being heard.
//
// Limits to state plainly: no TURN relay is configured, so peers behind strict networks will
// not connect. A host can also disable the microphone through its Permissions Policy.
import { reactive, watch } from 'vue'
import type { MemberId } from '../shared/ids.ts'
import { distance } from '../shared/geo.ts'
import { PROXIMITY_RADIUS } from '../shared/model.ts'
import { api, messageOf, myId, onAccountReset, onReconnect, onServerEvent } from '../state/app.ts'
import { channelLevel } from '../state/sound.ts'
import { getEngine, world } from '../state/world.ts'

type VoiceState = 'off' | 'live' | 'muted'

function microphoneBlockedReason(): string {
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser does not offer a microphone to web pages.'
  const policy = document as Document & { permissionsPolicy?: { allowsFeature(name: string): boolean }; featurePolicy?: { allowsFeature(name: string): boolean } }
  const allows = policy.permissionsPolicy ?? policy.featurePolicy
  if (allows && !allows.allowsFeature('microphone')) return 'The microphone is switched off for this page by the host, so voice is unavailable here.'
  return ''
}

const blocked = microphoneBlockedReason()
export const voice = reactive({
  state: 'off' as VoiceState,
  peers: [] as MemberId[],
  /** Peers with an established audio connection. */
  connected: [] as MemberId[],
  available: !blocked,
  unavailableReason: blocked,
  starting: false,
  problem: '',
})

interface Peer { connection: RTCPeerConnection; audio: HTMLAudioElement; makingOffer: boolean }
const peers = new Map<MemberId, Peer>()
let stream: MediaStream | null = null
/** Bumped by every start and every stop. A start that finds it changed has been cancelled and must not touch anything. */
let generation = 0
const ICE: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }

function closePeer(id: MemberId): void {
  const peer = peers.get(id)
  if (!peer) return
  peer.connection.close()
  peer.audio.srcObject = null
  peer.audio.remove()
  peers.delete(id)
  voice.connected = voice.connected.filter(entry => entry !== id)
}

function openPeer(id: MemberId): Peer {
  const existing = peers.get(id)
  if (existing) return existing
  const connection = new RTCPeerConnection(ICE)
  const audio = document.createElement('audio')
  audio.autoplay = true
  audio.setAttribute('playsinline', '')
  audio.muted = channelLevel('voice') === 0
  document.body.append(audio)
  const peer: Peer = { connection, audio, makingOffer: false }
  peers.set(id, peer)
  fadePeers()
  for (const track of stream?.getTracks() ?? []) connection.addTrack(track, stream!)
  connection.ontrack = event => { audio.srcObject = event.streams[0] ?? null }
  connection.onicecandidate = event => { if (event.candidate) void api('voice.signal', { to: id, data: { candidate: event.candidate.toJSON() } }).catch(() => undefined) }
  connection.onconnectionstatechange = () => {
    if (connection.connectionState === 'connected' && !voice.connected.includes(id)) voice.connected.push(id)
    if (['failed', 'closed', 'disconnected'].includes(connection.connectionState)) voice.connected = voice.connected.filter(entry => entry !== id)
  }
  return peer
}

async function offerTo(id: MemberId): Promise<void> {
  const peer = openPeer(id)
  peer.makingOffer = true
  try {
    await peer.connection.setLocalDescription(await peer.connection.createOffer())
    await api('voice.signal', { to: id, data: { description: peer.connection.localDescription } })
  } catch { if (peers.get(id) === peer) closePeer(id) } finally { peer.makingOffer = false }
}

/** Bring connections in line with the audience the service just announced. */
function applyPeers(list: MemberId[]): void {
  voice.peers = list
  for (const id of [...peers.keys()]) if (!list.includes(id)) closePeer(id)
  if (voice.state === 'off') return
  const me = myId()
  for (const id of list) {
    if (peers.has(id)) continue
    // One side starts each call, so two offers never cross: the smaller id offers.
    if (me && me < id) void offerTo(id)
    else openPeer(id)
  }
}

async function onSignal(from: MemberId, data: unknown): Promise<void> {
  if (voice.state === 'off' || !voice.peers.includes(from)) return
  const peer = openPeer(from)
  const signal = data as { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }
  try {
    if (signal.description) {
      await peer.connection.setRemoteDescription(signal.description)
      if (signal.description.type === 'offer') {
        await peer.connection.setLocalDescription(await peer.connection.createAnswer())
        await api('voice.signal', { to: from, data: { description: peer.connection.localDescription } })
      }
    } else if (signal.candidate) await peer.connection.addIceCandidate(signal.candidate)
  } catch { if (peers.get(from) === peer) closePeer(from) }
}

function stopAll(): void {
  generation++
  voice.starting = false
  for (const id of [...peers.keys()]) closePeer(id)
  stream?.getTracks().forEach(track => track.stop())
  stream = null
  voice.state = 'off'
  voice.peers = []
  voice.connected = []
}

export async function setVoice(next: VoiceState): Promise<void> {
  voice.problem = ''
  if (next === 'off') {
    stopAll()
    await api('voice.set', { state: 'off' }).catch(() => undefined)
    return
  }
  if (!voice.available) { voice.problem = voice.unavailableReason; return }
  const mine = ++generation
  const room = world.roomKey
  const cancelled = (): boolean => mine !== generation || room !== world.roomKey
  voice.starting = true
  try {
    const opened = stream ?? await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
    if (cancelled()) { if (opened !== stream) opened.getTracks().forEach(track => track.stop()); if (mine === generation) stopAll(); return }
    stream = opened
    for (const track of stream.getAudioTracks()) track.enabled = next === 'live'
    const result = await api('voice.set', { state: next })
    if (cancelled()) { if (mine === generation) stopAll(); return }
    voice.state = result.state
    applyPeers(result.peers)
  } catch (error) {
    if (mine !== generation) return
    stopAll()
    const name = error instanceof DOMException ? error.name : ''
    voice.problem = name === 'NotAllowedError' ? 'Microphone permission was not given. Nearby text still works.'
      : name === 'NotFoundError' ? 'No microphone was found on this device.' : messageOf(error)
  } finally { if (mine === generation) voice.starting = false }
}

onServerEvent(event => {
  if (event.type === 'voice.peers' && event.room === world.roomKey) applyPeers(event.peers)
  else if (event.type === 'voice.signal') void onSignal(event.from, event.data)
})

/** Each voice is as loud as the avatar is near, times the member's voice and master levels. */
function fadePeers(): void {
  const me = getEngine()?.position
  const heard = channelLevel('voice')
  for (const [id, peer] of peers) {
    const member = world.members.find(entry => entry.id === id)
    // Without a position there is no distance to fade by, so only the channel levels apply.
    const near = !me || !world.kind ? 1 : member ? Math.max(0, Math.min(1, 1.15 - distance(member.pos, me) / PROXIMITY_RADIUS[world.kind])) : 0
    // Some phones ignore volume, so a silenced channel also mutes the element.
    peer.audio.muted = heard === 0
    peer.audio.volume = near * heard
  }
}
watch(() => channelLevel('voice'), fadePeers, { flush: 'sync' })

// Changing room ends voice: the audience is per room and must be chosen again.
let lastRoom = world.roomKey
setInterval(() => {
  if (world.roomKey !== lastRoom) { lastRoom = world.roomKey; if (voice.state !== 'off' || voice.starting) stopAll() }
  fadePeers()
}, 400)

onReconnect(() => { if (voice.state !== 'off' || voice.starting) stopAll() })
onAccountReset(stopAll)
