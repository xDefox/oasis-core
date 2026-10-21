/**
 * Рендерер: WebGPU с автоматическим откатом на WebGL2.
 *
 * three r167+ умеет в одном рендерере и WebGPU, и WebGL2: если WebGPU
 * недоступен или упал на инициализации, бэкенд подменяется на WebGL2
 * без изменения кода сцены. Это ровно то, что нужно «бесплатному миру»:
 * страница должна открываться везде.
 */

import {
  AmbientLight,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  WebGPURenderer,
  type WebGPURenderer as WebGPURendererType,
} from 'three/webgpu';

export interface RendererBundle {
  renderer: WebGPURendererType;
  scene: Scene;
  camera: PerspectiveCamera;
  backend: 'webgpu' | 'webgl2';
  resize(): void;
}

export async function createRenderer(canvas: HTMLCanvasElement): Promise<RendererBundle> {
  const renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = false;

  await renderer.init();

  const scene = new Scene();
  scene.background = new Color(0x0b0e14);
  scene.fog = new Fog(0x0b0e14, 60, 260);

  const camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(0, 4, 10);

  const ambient = new AmbientLight(0xffffff, 0.55);
  scene.add(ambient);

  const hemisphere = new HemisphereLight(0xbcd4ff, 0x2a2f3a, 0.9);
  scene.add(hemisphere);

  const sun = new DirectionalLight(0xfff2d8, 1.35);
  sun.position.set(40, 80, 30);
  scene.add(sun);

  const resize = (): void => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', resize);

  // WebGPURenderer сам откатывается на WebGL2, если WebGPU недоступен.
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
    ? 'webgpu'
    : 'webgl2';

  return { renderer, scene, camera, backend, resize };
}
