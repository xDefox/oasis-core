import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Зонды и CI ходят на фиксированный порт: если vite «уедет» на 5174,
    // браузерные тесты будут стучаться в пустоту и это будет выглядеть как
    // падение продукта, а не порта.
    //
    // Номер переопределяет раннер браузерных тестов (OASIS_CLIENT_PORT),
    // иначе второй прогон на той же машине упирается в занятый 5173.
    // Дефолт не меняется.
    port: Number(process.env.OASIS_CLIENT_PORT ?? 5173),
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
