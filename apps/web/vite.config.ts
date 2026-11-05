import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022', sourcemap: false },
  server: { port: 8601, host: '127.0.0.1' },
});
