import react from '@vitejs/plugin-react'
export default {
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  build: { outDir: 'dist' },
}
