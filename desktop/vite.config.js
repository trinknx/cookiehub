import react from '@vitejs/plugin-react'
export default {
  base: './',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  build: { outDir: 'dist' },
}
