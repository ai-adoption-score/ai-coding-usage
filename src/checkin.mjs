// @ts-check
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CLIENT_VERSION, post } from './api.mjs'
import { isCurrentConfig, readConfig } from './config.mjs'
import { hookState, uninstallAll } from './install.mjs'
import { log } from './log.mjs'
import { paths } from './paths.mjs'
import { localDay } from './rows.mjs'
import { readState, updateState } from './state.mjs'

/**
 * The hourly check-in (a launchd agent): tells the survey this Mac is there, and whether each tool's hook is still in
 * place and running. It sends no usage numbers. A day with a check-in and no use is a real zero in the report; a day
 * without one is a gap.
 */

const NOT_APPROVED_GRACE_MS = 15 * 60_000

/** Whether any of a tool's records changed since a moment: only file dates are read, never their contents. */
function recordsChangedSince(dir, since) {
  if (!existsSync(dir)) return false
  const stack = [dir]
  while (stack.length > 0) {
    const current = /** @type {string} */ (stack.pop())
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.name.endsWith('.jsonl')) {
        try {
          if (statSync(path).mtimeMs > since) return true
        } catch {
          // Gone between listing and reading.
        }
      }
    }
  }
  return false
}

/**
 * A tool's hook as the check-in reports it: `not-approved` when it is in place but hasn't run since connecting although
 * the tool was used, as with a Codex hook nobody approved yet.
 * @param {'claude-code' | 'codex'} tool
 */
export function reportedHookState(tool, config, state, env = process.env) {
  const present = hookState(tool, env)
  if (present !== 'installed') return present
  const ran = state.hookRuns?.[tool]
  const connected = Date.parse(config.connectedAt)
  if (ran && Date.parse(ran) >= connected) return 'installed'
  // A session open while connecting keeps writing before its hook first runs: only use well after connecting counts.
  const records = tool === 'claude-code' ? paths(env).claudeRecords : paths(env).codexRecords
  return recordsChangedSince(records, connected + NOT_APPROVED_GRACE_MS) ? 'not-approved' : 'installed'
}

export async function runCheckIn(env = process.env) {
  const config = readConfig(env)
  if (!config) {
    // Settings gone but the check-in left behind: take it away too.
    uninstallAll(env)
    return 0
  }
  const state = readState(env)
  const checkIn = {
    day: localDay(Date.now()),
    claudeHook: reportedHookState('claude-code', config, state, env),
    codexHook: reportedHookState('codex', config, state, env),
  }
  try {
    const response = await post(config.server, '/api/usage/sync', { schemaVersion: 1, clientVersion: CLIENT_VERSION, rows: [], checkIn }, config.token)
    const status = response.body?.status
    if ((status === 'revoked' || status === 'closed') && !isCurrentConfig(config, env)) {
      log(`check-in: ${status} for an earlier connection; this Mac connected again, so nothing is removed`, env)
      return 0
    }
    if (status === 'revoked' || status === 'closed') {
      log(`check-in: ${status}, removing the add-on`, env)
      uninstallAll(env)
      return 0
    }
    updateState((current) => {
      current.lastCheckInAt = new Date().toISOString()
    }, env)
    log(`check-in: ${response.status} ${status ?? ''} claude=${checkIn.claudeHook} codex=${checkIn.codexHook}`, env)
  } catch (error) {
    log(`check-in failed: ${error instanceof Error ? error.message : String(error)}`, env)
  }
  return 0
}
