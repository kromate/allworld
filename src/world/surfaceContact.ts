import * as THREE from 'three'

export function makeContactShadows(): { mesh: THREE.InstancedMesh; update(points: { x: number; z: number }[], floor: number): void; dispose(): void } {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64
  const context = canvas.getContext('2d')!
  const shade = context.createRadialGradient(32, 32, 3, 32, 32, 32)
  shade.addColorStop(0, 'rgba(22,19,15,0.3)'); shade.addColorStop(0.42, 'rgba(22,19,15,0.17)'); shade.addColorStop(1, 'rgba(22,19,15,0)')
  context.fillStyle = shade; context.fillRect(0, 0, 64, 64)
  const texture = new THREE.CanvasTexture(canvas)
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 })
  const geometry = new THREE.PlaneGeometry(1, 1)
  const mesh = new THREE.InstancedMesh(geometry, material, 128)
  mesh.frustumCulled = false; mesh.count = 0; mesh.renderOrder = 1
  const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)), scale = new THREE.Vector3(1.05, 0.78, 1)
  return {
    mesh,
    update(points, floor) {
      mesh.count = Math.min(128, points.length)
      for (let i = 0; i < mesh.count; i++) {
        const point = points[i]!
        matrix.compose(new THREE.Vector3(point.x, floor, point.z), rotation, scale)
        mesh.setMatrixAt(i, matrix)
      }
      mesh.instanceMatrix.needsUpdate = true
    },
    dispose() { geometry.dispose(); material.dispose(); texture.dispose() },
  }
}
