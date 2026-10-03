import type { District } from '../geo/district.ts'
import type { Vec2 } from '../shared/geo.ts'

export interface MinimapOptions { radius?: number; headingUp?: boolean }
export interface MinimapMember extends Vec2 { friend: boolean }

/** Draw at HUD cadence, around 10 Hz. Canvas sizing and accessible text belong to the HUD. */
export class DistrictMinimap {
  private readonly district: District
  private readonly image: HTMLCanvasElement

  constructor(district: District) {
    this.district = district
    this.image = document.createElement('canvas')
    this.image.width = this.image.height = 1536
    const context = this.image.getContext('2d')!
    const scale = this.image.width / district.span
    context.fillStyle = '#202d30'
    context.fillRect(0, 0, 1536, 1536)
    context.translate(768, 768)
    context.scale(scale, scale)
    const polygon = (points: Vec2[]): void => {
      context.beginPath()
      points.forEach((p, i) => i ? context.lineTo(p.x, p.z) : context.moveTo(p.x, p.z))
      context.closePath()
      context.fill()
    }
    for (const ground of district.ground) {
      if (!['water', 'park', 'wood', 'grass'].includes(ground.kind)) continue
      context.fillStyle = ground.kind === 'water' ? '#25485a' : '#304c3e'
      polygon(ground.outer)
    }
    context.fillStyle = '#4a5354'
    for (const building of district.buildings) polygon(building.outer)
    context.lineJoin = context.lineCap = 'round'
    for (const road of district.roads) {
      if (road.tunnel) continue
      context.strokeStyle = road.kind === 'path' ? '#718678' : '#b9b7aa'
      context.lineWidth = Math.max(road.width, 1.2 / scale)
      context.beginPath()
      road.points.forEach((p, i) => i ? context.lineTo(p.x, p.z) : context.moveTo(p.x, p.z))
      context.stroke()
    }
  }

  draw(canvas: HTMLCanvasElement, player: Vec2, heading: number, members: MinimapMember[], options: MinimapOptions = {}): void {
    const context = canvas.getContext('2d')
    if (!context) return
    const width = canvas.width, height = canvas.height
    const size = Math.min(width, height), radius = Math.max(35, options.radius ?? 130)
    const scale = size / (radius * 2), mapScale = this.district.span / this.image.width
    const rotation = options.headingUp ? heading + Math.PI : 0
    context.clearRect(0, 0, width, height)
    context.save()
    context.translate(width / 2, height / 2)
    context.beginPath(); context.arc(0, 0, size / 2 - 1, 0, Math.PI * 2); context.clip()
    context.fillStyle = '#162529'; context.fillRect(-width / 2, -height / 2, width, height)
    context.rotate(rotation)
    context.scale(scale, scale)
    context.translate(-player.x, -player.z)
    context.drawImage(this.image, -this.district.span / 2, -this.district.span / 2, this.image.width * mapScale, this.image.height * mapScale)
    const dot = (p: Vec2, color: string, pixels: number): void => {
      if (Math.hypot(p.x - player.x, p.z - player.z) > radius) return
      context.fillStyle = color
      context.beginPath(); context.arc(p.x, p.z, pixels / scale, 0, Math.PI * 2); context.fill()
    }
    for (const poi of this.district.pois) dot(poi.pos, '#d9b97d', size * 0.014)
    for (const member of members) dot(member, member.friend ? '#f5c267' : '#8ce8d0', size * 0.022)
    context.restore()
    context.save()
    context.translate(width / 2, height / 2)
    context.rotate(options.headingUp ? 0 : Math.PI - heading)
    const arrow = size * 0.043
    context.fillStyle = '#fff7e5'; context.strokeStyle = '#172729'; context.lineWidth = 2
    context.beginPath(); context.moveTo(0, -arrow); context.lineTo(arrow * 0.65, arrow); context.lineTo(0, arrow * 0.55); context.lineTo(-arrow * 0.65, arrow); context.closePath(); context.fill(); context.stroke()
    context.restore()
    context.save()
    context.translate(width / 2, height / 2)
    const north = -Math.PI / 2 + rotation
    context.font = `700 ${Math.max(12, size * 0.075)}px system-ui`
    context.fillStyle = '#fff7e5'; context.textAlign = 'center'; context.textBaseline = 'middle'
    context.fillText('N', Math.cos(north) * size * 0.41, Math.sin(north) * size * 0.41)
    context.strokeStyle = '#9baea5'; context.lineWidth = 2
    context.beginPath(); context.arc(0, 0, size / 2 - 1, 0, Math.PI * 2); context.stroke()
    context.restore()
  }
}
