// @ts-check
import { spawn } from 'node:child_process'
import { readConfig } from './config.mjs'
import { log } from './log.mjs'
import { paths } from './paths.mjs'
import { readState, updateState } from './state.mjs'

/**
 * What a Claude Code or Codex hook runs. It notes that the tool's hook ran, decides whether a sync is due, and if so
 * starts one in the background and returns at once. It prints nothing: text a SessionStart hook prints would go into
 * the conversation, and Codex refuses any text from a Stop hook. It never fails the tool.
 */

/** A sync at most this often while someone works; a session's end always syncs. */
const THROTTLE_MS = 5 * 60_000
const STDIN_WAIT_MS = 500

function readStdin() {
  return new Promise((resolve) => {
    const chunks = []
    let finished = false
    const done = () => {
      if (finished) return
      finished = true
      // An open input would keep this process, and the tool waiting on it, alive.
      process.stdin.destroy()
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve({})
      }
    }
    if (process.stdin.isTTY) return resolve({})
    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', done)
    process.stdin.on('error', done)
    setTimeout(done, STDIN_WAIT_MS).unref()
  })
}

/** Whether this event should start a sync now. */
export function syncIsDue(event, state, now = Date.now()) {
  if (state.notBefore && Date.parse(state.notBefore) > now) return false
  const last = state.lastSyncStartedAt ? Date.parse(state.lastSyncStartedAt) : 0
  if (event === 'SessionEnd') return now - last > 30_000
  if (event === 'Stop' || event === 'SessionStart') return now - last >= THROTTLE_MS
  return false
}

/** @param {'claude-code' | 'codex'} tool */
export async function runHook(tool, env = process.env) {
  try {
    const input = await readStdin()
    const config = readConfig(env)
    if (!config) return
    const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : 'Stop'
    const now = new Date()
    const state = updateState((current) => {
      current.hookRuns = { ...current.hookRuns, [tool]: now.toISOString() }
    }, env)
    if (!syncIsDue(event, state, now.getTime())) return
    const child = spawn(process.execPath, [paths(env).appBin, 'sync', '--background', '--reason', `${tool}:${event}`], {
      detached: true,
      stdio: 'ignore',
      env,
    })
    child.unref()
  } catch (error) {
    log(`hook ${tool} failed: ${error instanceof Error ? error.message : String(error)}`, env)
  }
}

export { readState }
