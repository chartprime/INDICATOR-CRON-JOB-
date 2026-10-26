export type ProxyEnv = Record<string, string | undefined>

const DEFAULT_LIVE_ORIGIN = 'http://127.0.0.1:8001'

function httpOriginFromEnv(name: string, fallback: string, env: ProxyEnv): string {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = raw.trim()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must be an http(s) origin`)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not include credentials, query or fragment`)
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`${name} must be an origin with no path`)
  }
  return url.origin
}

function wsOrigin(httpOrigin: string): string {
  const url = new URL(httpOrigin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.origin
}

export function mergeProxyEnvironments(repositoryEnv: ProxyEnv, webEnv: ProxyEnv, inherited: ProxyEnv): ProxyEnv {
  return { ...repositoryEnv, ...webEnv, ...inherited }
}

export function proxySettingsForEnv(env: ProxyEnv) {
  const liveOrigin = httpOriginFromEnv('TT_LIVE_PROXY_URL', DEFAULT_LIVE_ORIGIN, env)
  const archiveOrigin = httpOriginFromEnv('TT_ARCHIVE_PROXY_URL', liveOrigin, env)
  return {
    allowedHosts: env.VITE_ALLOWED_HOST ? [env.VITE_ALLOWED_HOST] : [],
    liveOrigin,
    archiveOrigin,
    liveWebSocketOrigin: wsOrigin(liveOrigin),
  }
}
