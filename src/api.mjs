// @ts-check
import { readFileSync } from 'node:fs'

/** Talking to the survey's server. Only JSON with numbers and names goes out; the device token goes in a header. */

const TIMEOUT_MS = 20_000

export const CLIENT_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

/** Plain http goes only to this Mac itself, for testing; the device token goes anywhere else over https. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Why the add-on won't talk to `server`, or null when it will. @param {string} server */
export function serverProblem(server) {
  let url
  try {
    url = new URL(server)
  } catch {
    return `"${server}" isn't a web address.`
  }
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) return null
  return `"${server}" isn't https. Plain http works only for this Mac's own address (localhost), for testing.`
}

/**
 * @param {string} server @param {string} path @param {unknown} body @param {string} [token]
 * @returns {Promise<{ status: number, body: any, retryAfterSeconds: number | null }>}
 */
export async function post(server, path, body, token) {
  return request(server, path, 'POST', body, token)
}

/**
 * @param {string} server @param {string} path @param {string} [token]
 * @returns {Promise<{ status: number, body: any, retryAfterSeconds: number | null }>}
 */
export async function get(server, path, token) {
  return request(server, path, 'GET', undefined, token)
}

/** @param {string} server @param {string} path @param {'GET' | 'POST'} method @param {unknown} body @param {string} [token] */
async function request(server, path, method, body, token) {
  const problem = serverProblem(server)
  if (problem) throw new Error(problem)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(new URL(path, server), {
      method,
      headers: {
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        'user-agent': `ai-coding-usage/${CLIENT_VERSION}`,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    })
    let parsed = null
    try {
      parsed = await response.json()
    } catch {
      parsed = null
    }
    const retryAfter = Number(response.headers.get('retry-after'))
    return { status: response.status, body: parsed, retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null }
  } finally {
    clearTimeout(timer)
  }
}
