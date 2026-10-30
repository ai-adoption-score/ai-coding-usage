// @ts-check
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { CLIENT_VERSION, serverProblem } from './api.mjs'
import { log } from './log.mjs'
import { paths } from './paths.mjs'
import { readState, updateState } from './state.mjs'

/**
 * The add-on keeps itself up to date (owner, 2026-10-30): once a day the ping-back asks npm for the latest version.
 * When there is a newer one, it downloads it, checks it is byte for byte the file npm lists for that version, checks
 * that it starts on this Mac's Node, and puts it in place of its own copy; the next hook or ping-back runs it. Nothing
 * is sent to npm but the request itself. The hooks, the ping-back and the settings stay as they are, and anything that
 * goes wrong leaves the copy that works.
 */

const PACKAGE = '@ai-adoption-score/ai-coding-usage'
const REGISTRY = 'https://registry.npmjs.org'
const CHECK_EVERY_MS = 24 * 60 * 60_000
const TIMEOUT_MS = 30_000
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024

/** "1.2.3" as numbers; null for anything else, such as a pre-release. @param {unknown} version */
function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version))
  return match ? match.slice(1).map(Number) : null
}

/** Whether `candidate` is a later release than `current`; never a step back. @param {unknown} candidate @param {unknown} current */
export function isNewer(candidate, current) {
  const next = versionParts(candidate)
  const now = versionParts(current)
  if (!next || !now) return false
  for (let index = 0; index < 3; index += 1) if (next[index] !== now[index]) return next[index] > now[index]
  return false
}

/** Whether this Node is new enough for `engines.node` written as ">=18.17"; any other form is left to the start check. */
function nodeFits(engines, running = process.versions.node) {
  const wanted = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(engines?.node ?? '').trim())
  if (!wanted) return true
  const need = wanted.slice(1).map((part) => Number(part ?? 0))
  const have = running.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) if ((have[index] ?? 0) !== need[index]) return (have[index] ?? 0) > need[index]
  return true
}

/** @param {string} url @param {Record<string, string>} headers */
async function download(url, headers = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, { headers: { 'user-agent': `ai-coding-usage/${CLIENT_VERSION}`, ...headers }, signal: controller.signal })
    if (!response.ok) throw new Error(`${url} answered ${response.status}`)
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length > MAX_DOWNLOAD_BYTES) throw new Error(`${url} is larger than expected`)
    return body
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The files of an npm package: a gzipped tar with every entry under `package/`. Only plain files whose path stays
 * inside the package are read; links and anything else are left out.
 * @param {Buffer} tarball @returns {Map<string, { data: Buffer, mode: number }>}
 */
export function readPackage(tarball) {
  const archive = gunzipSync(tarball)
  const files = new Map()
  /** @type {string | null} */
  let paxPath = null
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0[\s\S]*$/, '')
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1) || '0'
    const prefix = field(257, 5) === 'ustar' ? field(345, 155) : ''
    const name = paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    paxPath = null
    const body = archive.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === 'x') {
      // An extended header: its `path` names the next entry.
      paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? null
      continue
    }
    if (type !== '0') continue
    const parts = name.split('/')
    if (parts[0] !== 'package' || parts.length < 2 || parts.some((part) => part === '' || part === '.' || part === '..')) continue
    files.set(parts.slice(1).join('/'), { data: Buffer.from(body), mode: parseInt(field(100, 8).trim() || '644', 8) & 0o755 })
  }
  return files
}

/**
 * Puts `version` in place of the add-on's copy, when it is the one npm lists and it starts here.
 * @param {{ version: string, dist?: { tarball?: string, integrity?: string } }} manifest @param {string} registry
 */
async function install(manifest, registry, env) {
  const where = paths(env)
  const tarball = manifest.dist?.tarball
  const integrity = /^sha512-(.+)$/.exec(manifest.dist?.integrity ?? '')?.[1]
  if (!tarball || !integrity || new URL(tarball).origin !== new URL(registry).origin) throw new Error(`npm lists no file for ${manifest.version} that can be checked`)
  const archive = await download(tarball)
  if (createHash('sha512').update(archive).digest('base64') !== integrity) throw new Error(`the file for ${manifest.version} isn't the one npm lists`)
  const files = readPackage(archive)
  const listed = JSON.parse(files.get('package.json')?.data.toString('utf8') ?? '{}')
  if (listed.name !== PACKAGE || listed.version !== manifest.version || !files.has('bin/ai-coding-usage.mjs')) throw new Error(`the file for ${manifest.version} isn't this add-on`)

  // The new copy beside the old one, as connecting puts it: its program and its package.json, nothing else.
  const fresh = `${where.app}.update`
  const previous = `${where.app}.previous`
  rmSync(fresh, { recursive: true, force: true })
  try {
    for (const [path, file] of files) {
      if (path !== 'package.json' && !path.startsWith('bin/') && !path.startsWith('src/')) continue
      mkdirSync(dirname(join(fresh, path)), { recursive: true })
      writeFileSync(join(fresh, path), file.data, { mode: file.mode })
    }
    try {
      // It has to start on this Node before it replaces the copy that works: its help loads all of it and exits.
      execFileSync(process.execPath, [join(fresh, 'bin', 'ai-coding-usage.mjs'), 'help'], { stdio: 'ignore', timeout: TIMEOUT_MS, env })
    } catch {
      throw new Error(`${manifest.version} doesn't start on Node ${process.versions.node}`)
    }
    rmSync(previous, { recursive: true, force: true })
    renameSync(where.app, previous)
    try {
      renameSync(fresh, where.app)
    } catch (error) {
      renameSync(previous, where.app)
      throw error
    }
    rmSync(previous, { recursive: true, force: true })
  } finally {
    rmSync(fresh, { recursive: true, force: true })
  }
}

/**
 * The ping-back's daily look at npm. `AI_ADOPTION_SCORE_REGISTRY` points it at another registry, for testing; like the
 * survey's server, it has to be https, or http on this Mac itself.
 * @returns {Promise<'not-due' | 'up-to-date' | 'updated' | 'skipped'>}
 */
export async function updateIfDue(env = process.env, now = Date.now()) {
  const last = readState(env).lastUpdateCheckAt
  if (last && now - Date.parse(last) < CHECK_EVERY_MS) return 'not-due'
  const registry = env.AI_ADOPTION_SCORE_REGISTRY || REGISTRY
  const problem = serverProblem(registry)
  if (problem) throw new Error(problem)
  const document = JSON.parse(
    (await download(`${registry.replace(/\/+$/, '')}/${PACKAGE.replace('/', '%2f')}`, { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' })).toString('utf8')
  )
  // npm answered: the next look is tomorrow, whatever happens next.
  updateState((current) => {
    current.lastUpdateCheckAt = new Date(now).toISOString()
  }, env)
  const latest = document?.['dist-tags']?.latest
  const manifest = document?.versions?.[latest]
  if (!isNewer(latest, CLIENT_VERSION) || !manifest) return 'up-to-date'
  if (manifest.deprecated || !nodeFits(manifest.engines)) {
    log(`update: ${latest} is out, but ${manifest.deprecated ? 'it was withdrawn' : `it needs Node ${manifest.engines.node}`}; staying on ${CLIENT_VERSION}`, env)
    return 'skipped'
  }
  await install(manifest, registry, env)
  log(`update: ${CLIENT_VERSION} → ${latest}`, env)
  return 'updated'
}
