import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // リポジトリ名に合わせて前後にスラッシュを入れて指定
  base: '/newotoge-web/',
});