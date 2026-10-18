// @ts-check
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { paths } from './paths.mjs'

/**
 * What the add-on remembers between runs, beside its settings: which rows the server accepted (by a hash of each), when
 * it last synced, when each tool's hook last ran, and how long the server asked it to wait. Only names and numbers.
 *
 * @typedef {{
 *   sent: Record<string, string>,
 *   lastSyncStartedAt?: string, lastSyncAt?: string, notBefore?: string,
 *   hookRuns: Partial<Record<'claude-code' | 'codex', string>>,
 *   lastCheckInAt?: string, lastError?: string
 * }} UsageState
 */

/** @returns {UsageState} */
export function readState(env = process.env) {
  try {
    const state = JSON.parse(readFileSync(paths(env).state, 'utf8'))
    return { sent: {}, hookRuns: {}, ...state }
  } catch {
    return { sent: {}, hookRuns: {} }
  }
}

/** @param {UsageState} state */
export function writeState(state, env = process.env) {
  const path = paths(env).state
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 })
  renameSync(temporary, path)
}

/** Reads, changes and writes the state; the change sees the latest copy, as another run may have written one. */
export function updateState(change, env = process.env) {
  const state = readState(env)
  change(state)
  writeState(state, env)
  return state
}
