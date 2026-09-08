import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// L'interface vit dans web/ et se construit vers web/dist/, servi ensuite par
// le meme serveur Hono que l'API : un seul processus a deployer.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    // En developpement, Vite sert l'interface et relaie les appels API vers
    // le serveur Node : pas de CORS a gerer, pas de reconstruction a chaque
    // modification.
    proxy: {
      '/app/api': 'http://localhost:8787',
      '/admin/api': 'http://localhost:8787',
      '/webhook': 'http://localhost:8787',
      '/health': 'http://localhost:8787',
    },
  },
});
