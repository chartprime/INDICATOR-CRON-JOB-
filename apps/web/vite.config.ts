import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { mergeProxyEnvironments, proxySettingsForEnv } from './proxy-config.ts'

export const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const TERMINAL_D_ENV_PREFIXES = ['VITE_', 'TT_LIVE_PROXY_URL', 'TT_ARCHIVE_PROXY_URL']
type EnvLoader = (mode: string, envDir: string, prefixes: string | string[]) => Record<string, string>

export function proxyEnvForMode(
  mode: string,
  load: EnvLoader = loadEnv,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return mergeProxyEnvironments(
    load(mode, REPOSITORY_ROOT, TERMINAL_D_ENV_PREFIXES),
    {},
    inherited,
  )
}

export function configForEnv(env: NodeJS.ProcessEnv) {
  const { allowedHosts, liveOrigin, archiveOrigin, liveWebSocketOrigin } = proxySettingsForEnv(env)
  const served = {
    host: '127.0.0.1',
    port: 8000,
    strictPort: true,
    allowedHosts,
    proxy: {
      '/ws': {
        target: liveWebSocketOrigin,
        ws: true,
      },
      '/health': {
        target: liveOrigin,
        changeOrigin: true,
      },
      '/archive': {
        target: archiveOrigin,
        changeOrigin: true,
      },
      '/heatmap': {
        target: liveOrigin,
        changeOrigin: true,
      },
    },
  }
  return {
    plugins: [react()],
    envDir: REPOSITORY_ROOT,
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 3 },
              { name: 'charts', test: /node_modules[\\/](lightweight-charts|fancy-canvas)[\\/]/, priority: 2 },
              { name: 'vendor', test: /node_modules[\\/]/, priority: 1 },
              { name: 'indicators', test: /src[\\/]lib[\\/]indicators[\\/]/, priority: 1 },
            ],
          },
        },
      },
    },
    server: served,
    preview: served,
    test: {
      // Tests run in Node unless a file asks for a browser with
      // `// @vitest-environment jsdom`: a page's DOM costs set-up on every file.
      environment: 'node',
      setupFiles: ['./src/test/setup.ts'],
      testTimeout: 20_000,
    },
  }
}

export default defineConfig(({ mode }) => configForEnv(proxyEnvForMode(mode)))
