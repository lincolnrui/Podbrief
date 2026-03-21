import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

function replaceProcessEnvPlugin(geminiKey: string | undefined) {
  return {
    name: 'replace-process-env',
    transform(code: string, id: string) {
      if (code.includes('process.env.GEMINI_API_KEY')) {
        return {
          code: code.replace(/process\.env\.GEMINI_API_KEY/g, JSON.stringify(geminiKey || '')),
          map: null
        };
      }
    }
  };
}

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  const geminiKey = env.GEMINI_API_KEY || process.env['GEMINI_API_KEY'];
  return {
    plugins: [react(), tailwindcss(), replaceProcessEnvPlugin(geminiKey)],
    define: {
      'process.env.NEXT_PUBLIC_SUPABASE_URL': JSON.stringify(env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL),
      'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY': JSON.stringify(env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
