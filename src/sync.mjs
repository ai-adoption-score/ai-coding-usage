// @ts-check
import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { constants, setPriority } from 'node:os'
import { get, post, CLIENT_VERSION } from './api.mjs'
import { reportedHookState } from './checkin.mjs'
import { isShared } from './choice.mjs'
import { isCurrentConfig, writeConfig } from './config.mjs'
import { hookState, uninstallAll } from './install.mjs'
import { log } from './log.mjs'
import { paths } from './paths.mjs'
import { localDay } from './rows.mjs'
import { scanUsage } from './scan.mjs'
import { readState, updateState } from './state.mjs'

/** Rows per request, and bytes, comfortably under the server's limits (500 rows, 256 KB). */
const MAX_ROWS = 400
const MAX_BYTES = 200 * 1024
/** A sync that started this long ago and still holds the lock has died. */
const STALE_LOCK_MS = 15 * 60_000

/** @param {import('./rows.mjs').UsageRow[]} rows */
export function batches(rows) {
  /** @type {import('./rows.mjs').UsageRow[][]} */
  const result = []
  let current = []
  let size = 0
  for (const row of rows) {
    const rowSize = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1
    if (current.length > 0 && (current.length >= MAX_ROWS || size + rowSize > MAX_BYTES)) {
      result.push(current)
      current = []
      size = 0
    }
    current.push(row)
    size += rowSize
  }
  if (current.length > 0) result.push(current)
  return result
}

export const rowKey = (row) => [row.tool, row.sessionKey, row.day, row.repository ?? '', row.branch ?? ''].join('|')
export const rowHash = (row) => createHash('sha256').update(JSON.stringify(row)).digest('hex').slice(0, 32)

/**
 * Whether a tool's new numbers go out: all of them in the first sync, the one that connects; after that, only while
 * the tool's own hook is in place and has run since connecting. Declining the Codex hook pauses Codex that way, even
 * while Claude Code keeps sending.
 * @param {'claude-code' | 'codex'} tool
 */
export function sendsTool(tool, config, state, env = process.env) {
  if (!config.initialSyncDone) return true
  const ran = state.hookRuns?.[tool]
  return hookState(tool, env) === 'installed' && Boolean(ran) && Date.parse(ran) >= Date.parse(config.connectedAt)
}

/** One sync at a time, across hooks and the check-in. @returns {(() => void) | null} */
function takeLock(env) {
  const path = paths(env).lock
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = openSync(path, 'wx', 0o600)
      writeSync(handle, JSON.stringify({ pid: process.pid, at: Date.now() }))
      closeSync(handle)
      return () => rmSync(path, { force: true })
    } catch {
      let holder = null
      try {
        holder = JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        holder = null
      }
      let alive = false
      try {
        if (holder?.pid) {
          process.kill(holder.pid, 0)
          alive = true
        }
      } catch {
        alive = false
      }
      if (alive && Date.now() - Number(holder.at) < STALE_LOCK_MS) return null
      rmSync(path, { force: true })
    }
  }
  return null
}

/**
 * What the person chose to share, asked before every sync, so a choice made on their page applies at once.
 * @param {import('./config.mjs').UsageConfig} config
 * @returns {Promise<{ status: string, choice: import('./choice.mjs').RepositoryChoice | null, retryAfterSeconds: number | null }>}
 */
export async function askChoice(config) {
  const response = await get(config.server, '/api/usage/repositories', config.token)
  if (response.status === 429) return { status: 'waiting', choice: null, retryAfterSeconds: response.retryAfterSeconds }
  const status = response.body?.status ?? (response.status === 401 ? 'revoked' : 'error')
  if (status === 'error') throw new Error(response.body?.error ?? `The server answered ${response.status}.`)
  return { status, choice: response.body?.choice ?? null, retryAfterSeconds: null }
}

/**
 * Counts the window and sends the rows that changed since the server last accepted them, with a check-in. Only the
 * repositories the person chose go out; before they choose, the sync is a check-in alone. Rows the server hasn't
 * accepted stay changed, so the next sync sends them: the Mac is the queue. A revoked connection or a closed survey
 * takes the add-on off this Mac.
 * @param {import('./config.mjs').UsageConfig} config
 * @param {{ background?: boolean, reason?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ status: string, accepted: number, rows: number, sessions: number }>}
 */
export async function syncNow(config, { background = false, reason = 'manual', env = process.env } = {}) {
  if (background) {
    try {
      // Low priority: the person's own work comes first.
      setPriority(constants.priority.PRIORITY_LOW)
    } catch {
      // Not allowed here; run anyway.
    }
  }
  const release = takeLock(env)
  if (!release) return { status: 'busy', accepted: 0, rows: 0, sessions: 0 }
  try {
    let state = readState(env)
    if (background && state.notBefore && Date.parse(state.notBefore) > Date.now()) return { status: 'waiting', accepted: 0, rows: 0, sessions: 0 }
    state = updateState((current) => {
      current.lastSyncStartedAt = new Date().toISOString()
    }, env)

    const asked = await askChoice(config)
    if (asked.status === 'waiting') {
      const wait = (asked.retryAfterSeconds ?? 600) * 1000
      updateState((current) => {
        current.notBefore = new Date(Date.now() + wait).toISOString()
      }, env)
      return { status: 'waiting', accepted: 0, rows: 0, sessions: 0 }
    }
    const { choice } = asked

    const scan = await scanUsage({ days: config.historyDays || 30, env })
    const included = scan.rows.filter((row) => sendsTool(row.tool, config, state, env) && isShared(choice, row.repository))
    const changed = included.filter((row) => state.sent[rowKey(row)] !== rowHash(row))
    const checkIn = {
      day: localDay(Date.now()),
      claudeHook: reportedHookState('claude-code', config, state, env),
      codexHook: reportedHookState('codex', config, state, env),
    }
    const groups = changed.length > 0 ? batches(changed) : [[]]
    let accepted = 0
    let status = asked.status === 'revoked' || asked.status === 'closed' ? asked.status : 'active'
    for (const [index, rows] of status === 'active' ? groups.entries() : []) {
      const body = { schemaVersion: 1, clientVersion: CLIENT_VERSION, rows, ...(index === 0 ? { checkIn } : {}) }
      const response = await post(config.server, '/api/usage/sync', body, config.token)
      status = response.body?.status ?? (response.status === 401 ? 'revoked' : 'error')
      if (response.status === 429 || status === 'paused') {
        const wait = (response.retryAfterSeconds ?? response.body?.nextSyncAfterSeconds ?? 600) * 1000
        updateState((current) => {
          current.notBefore = new Date(Date.now() + wait).toISOString()
        }, env)
        status = response.status === 429 ? 'waiting' : 'paused'
        break
      }
      if (status !== 'active') break
      if (response.status !== 200) throw new Error(response.body?.error ?? `The server answered ${response.status}.`)
      accepted += response.body.accepted
      // Remembered per batch, so a batch accepted before a later one fails isn't sent again.
      updateState((current) => {
        for (const row of rows) current.sent[rowKey(row)] = rowHash(row)
        current.lastSyncAt = new Date().toISOString()
        delete current.notBefore
        delete current.lastError
      }, env)
    }

    if ((status === 'revoked' || status === 'closed') && !isCurrentConfig(config, env)) {
      log(`sync (${reason}): ${status} for an earlier connection; this Mac connected again, so nothing is removed`, env)
    } else if (status === 'revoked' || status === 'closed') {
      log(`sync (${reason}): ${status}, removing the add-on`, env)
      uninstallAll(env)
    } else if (status === 'active') {
      // Forget rows that left the window.
      const keep = new Set(scan.rows.map(rowKey))
      updateState((current) => {
        current.sent = Object.fromEntries(Object.entries(current.sent).filter(([key]) => keep.has(key)))
      }, env)
      // The first sync is the one with the person's choice: it sends the last 30 days of every tool.
      if (choice && !config.initialSyncDone && isCurrentConfig(config, env)) writeConfig({ ...config, initialSyncDone: true, lastSyncAt: new Date().toISOString() }, env)
      log(`sync (${reason}): sent ${accepted} of ${included.length} rows`, env)
    } else {
      log(`sync (${reason}): ${status}`, env)
    }
    return { status, accepted, rows: included.length, sessions: new Set(included.map((row) => row.sessionKey)).size }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    updateState((current) => {
      current.lastError = message
    }, env)
    log(`sync (${reason}) failed: ${message}`, env)
    throw error
  } finally {
    release()
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Right after connecting, in the background: waits while the person chooses on their survey page, then sends the last
 * 30 days of what they chose. It gives up when the list on their page expires (an hour); the next sync after they
 * choose sends them all the same.
 * @param {import('./config.mjs').UsageConfig} config
 * @param {{ env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options]
 */
export async function waitForChoice(config, { env = process.env, timeoutMs = 60 * 60_000 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    // Running the line again replaces this connection; its own wait takes over.
    if (!isCurrentConfig(config, env)) return 'replaced'
    let asked
    try {
      asked = await askChoice(config)
    } catch (error) {
      log(`choice: ${error instanceof Error ? error.message : String(error)}`, env)
      asked = { status: 'choosing', choice: null, retryAfterSeconds: null }
    }
    if (asked.status === 'chosen' || asked.status === 'revoked' || asked.status === 'closed') {
      await syncNow(config, { background: true, reason: 'choice', env })
      return asked.status
    }
    if (asked.status === 'unchosen') return 'unchosen'
    // Every few seconds while the page is likely open, then less often.
    const waited = Date.now() - started
    await sleep(asked.status === 'waiting' ? (asked.retryAfterSeconds ?? 60) * 1000 : waited < 2 * 60_000 ? 3_000 : 15_000)
  }
  return 'timeout'
}

