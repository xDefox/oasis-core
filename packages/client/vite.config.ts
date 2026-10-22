import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // Зонды и CI ходят на фиксированный порт: если vite «уедет» на 5174,
    // браузерные тесты будут стучаться в пустоту и это будет выглядеть как
    // падение продукта, а не порта.
    strictPort: true,
    host: true,
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
