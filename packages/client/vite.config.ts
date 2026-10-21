import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    host: true,
    strictPort: false,
  },
  build: {
    target: 'esnext',
    sourcemap: true,
  },
  esbuild: {
    // three/webgpu содержит WGSL-шейдеры; таргетим современный браузер.
    target: 'esnext',
  },
});
