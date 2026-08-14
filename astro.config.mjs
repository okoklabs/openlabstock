import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

export default defineConfig({
  site: 'http://127.0.0.1:4388',
  output: 'static',
  outDir: './dist',
  integrations: [react()],
  vite: {
    ssr: {
      noExternal: ['@astrojs/react', 'react', 'react-dom', 'lucide-react'],
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4388,
  },
});
