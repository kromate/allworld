import * as THREE from 'three'

export function makeSky(): { mesh: THREE.Mesh; setTime(hour: number, day: number, golden: number): void; dispose(): void } {
  const uniforms = {
    zenith: { value: new THREE.Color('#6a9bbc') },
    horizon: { value: new THREE.Color('#dae4e5') },
    hazeColor: { value: new THREE.Color('#c8d7d6') },
    sunColor: { value: new THREE.Color('#fff1cc') },
    sunDirection: { value: new THREE.Vector3(1, 1, 0.5).normalize() },
    daylight: { value: 1 },
  }
  const geometry = new THREE.SphereGeometry(1400, 24, 12)
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, uniforms,
    vertexShader: `varying vec3 direction;
      void main() { direction = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec3 direction;
      uniform vec3 zenith; uniform vec3 horizon; uniform vec3 hazeColor; uniform vec3 sunColor; uniform vec3 sunDirection; uniform float daylight;
      float cloudHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float cloudNoise(vec2 p) {
        vec2 cell = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(cloudHash(cell), cloudHash(cell+vec2(1.,0.)),f.x), mix(cloudHash(cell+vec2(0.,1.)),cloudHash(cell+vec2(1.,1.)),f.x),f.y);
      }
      void main() {
        vec3 ray = normalize(direction);
        float height = pow(max(0.0, ray.y), 0.48);
        vec3 color = mix(horizon, zenith, height);
        float horizonHaze = 1.0 - smoothstep(-0.035, 0.19, ray.y);
        color = mix(color, hazeColor, horizonHaze * mix(0.28, 0.42, daylight));
        vec2 cloudPoint = ray.xz / max(0.13, ray.y + 0.2) * 2.3;
        float cloud = cloudNoise(cloudPoint)*0.6 + cloudNoise(cloudPoint*2.1)*0.27 + cloudNoise(cloudPoint*4.4)*0.13;
        float density = smoothstep(0.5, 0.72, cloud) * smoothstep(-0.02, 0.18, ray.y);
        vec3 cloudTone = mix(vec3(0.09,0.12,0.19), vec3(0.8,0.85,0.87), daylight);
        color = mix(color, cloudTone, density * 0.85);
        float facing = dot(ray, sunDirection);
        float glow = pow(max(0.0, facing), 80.0) * 0.18;
        float disc = smoothstep(0.99988, 0.99996, facing);
        color += sunColor * (glow + disc * 2.0) * daylight;
        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.renderOrder = -1000
  return {
    mesh,
    setTime(hour, day, golden) {
      const angle = (hour - 6) / 12 * Math.PI
      uniforms.zenith.value.set('#101c35').lerp(new THREE.Color('#6a9bbc'), day)
      uniforms.horizon.value.set('#293650').lerp(new THREE.Color('#d9e4e5'), day).lerp(new THREE.Color('#eeb888'), golden * day * 0.6)
      uniforms.hazeColor.value.set('#25344d').lerp(new THREE.Color('#c9d8d7'), day).lerp(new THREE.Color('#d99d78'), golden * (0.32 + day * 0.42))
      uniforms.sunDirection.value.set(Math.cos(angle) * 170, Math.max(0.18, Math.sin(angle)) * 190, 85).normalize()
      uniforms.daylight.value = day
    },
    dispose() { geometry.dispose(); material.dispose() },
  }
}
