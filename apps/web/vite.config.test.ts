// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEnv } from 'vite'
import { describe, expect, it } from 'vitest'
import { mergeProxyEnvironments, proxySettingsForEnv } from './proxy-config.ts'
import { configForEnv, proxyEnvForMode } from './vite.config.ts'

describe('Terminal D environment', () => {
  it('reads only the proxy origins and browser settings from a shared .env that also holds operator secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'terminal-d-env-'))
    try {
      writeFileSync(join(dir, '.env'), [
        'TT_ARCHIVE_PROXY_URL=http://10.88.0.1:8001',
        'TT_LIVE_PROXY_URL=http://127.0.0.1:8001',
        'VITE_ARCHIVE_CLIENT_TOKEN=bearer-value',
        'TT_QUERY_S3_SECRET_ACCESS_KEY=s3-secret',
        'TT_QUERY_SERVICE_SECRET=service-secret',
        'RCLONE_CONFIG_TTCONVERT_SECRET_ACCESS_KEY=convert-secret',
        'TT_LIVE_STORAGE_CLIENT_TOKEN=runtime-bearer',
        'databento_key=provider-key',
        '',
      ].join('\n'))
      const env = proxyEnvForMode('development', (mode, _envDir, prefixes) => loadEnv(mode, dir, prefixes), {})

      expect(Object.keys(env).sort()).toEqual(['TT_ARCHIVE_PROXY_URL', 'TT_LIVE_PROXY_URL', 'VITE_ARCHIVE_CLIENT_TOKEN'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Vite proxy configuration', () => {
  it('combines ordered environment layers with later values taking precedence', () => {
    const env = mergeProxyEnvironments(
      { TT_ARCHIVE_PROXY_URL: 'http://10.88.0.1:8001', VITE_ALLOWED_HOST: 'repository.example.test' },
      { TT_ARCHIVE_PROXY_URL: 'http://10.88.0.2:8001' },
      { VITE_ALLOWED_HOST: 'web.example.test' },
    )

    expect(env).toMatchObject({
      TT_ARCHIVE_PROXY_URL: 'http://10.88.0.2:8001',
      VITE_ALLOWED_HOST: 'web.example.test',
    })
  })

  it('keeps live traffic local while routing archive traffic to the configured host gateway', () => {
    const settings = proxySettingsForEnv({
      TT_LIVE_PROXY_URL: 'http://127.0.0.1:8001',
      TT_ARCHIVE_PROXY_URL: 'http://10.88.0.1:8001',
    })

    expect(settings.liveWebSocketOrigin).toBe('ws://127.0.0.1:8001')
    expect(settings.liveOrigin).toBe('http://127.0.0.1:8001')
    expect(settings.archiveOrigin).toBe('http://10.88.0.1:8001')
  })

  it('refuses a proxy URL that could redirect browser requests to a path or credentials', () => {
    expect(() => proxySettingsForEnv({ TT_ARCHIVE_PROXY_URL: 'https://user:pass@10.88.0.1:8001/archive' })).toThrow(
      'TT_ARCHIVE_PROXY_URL must not include credentials, query or fragment',
    )
  })

  // A viewer over a tunnel waited on the dev server's unbundled first load
  // (hand test 2026-09-30). The built bundle served by `vite preview` must
  // sit at the same address with the same proxies, so the tunnel is unchanged.
  it('serves the built bundle on the same address, hosts and proxies as the dev server', () => {
    const config = configForEnv({ TT_LIVE_PROXY_URL: 'http://127.0.0.1:8001', VITE_ALLOWED_HOST: 'web.example.test' })

    expect(config.preview).toEqual(config.server)
    expect(config.preview).toMatchObject({ host: '127.0.0.1', port: 8000, strictPort: true })
    expect(Object.keys(config.preview.proxy).sort()).toEqual(['/archive', '/health', '/heatmap', '/ws'])
    expect(config.preview.proxy['/ws']).toEqual({ target: 'ws://127.0.0.1:8001', ws: true })
  })
})
