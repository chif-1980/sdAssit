import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import packageJson from './package.json' with { type: 'json' };

export default defineConfig({
  plugins: [react()],
  build: {
    // A release must not reuse URLs cached from a failed previous deployment.
    assetsDir: `assets/${packageJson.version}`,
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      // The enterprise assistant uses the Yuxi API for authenticated,
      // persistent conversations.
      '/api': 'http://127.0.0.1:5050',
      '/minio/public': {
        target: 'http://127.0.0.1:9000',
        rewrite: (path) => path.replace(/^\/minio/, ''),
      },
    },
  },
});
