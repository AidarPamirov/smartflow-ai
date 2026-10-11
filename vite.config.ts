import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' — сборку можно положить в любую папку статического хостинга (GitHub Pages и т.п.)
export default defineConfig({
  plugins: [react()],
  base: './',
});
