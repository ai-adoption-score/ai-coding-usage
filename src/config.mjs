// @ts-check
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The add-on's own folder, `~/.ai-adoption-score`: the connection's settings and its device token. Only the person's
 * own account can read it. `AI_ADOPTION_SCORE_HOME` points it elsewhere, for testing.
 *
 * @typedef {{ server: string, token: string, companyName: string, connectedAt: string, syncIntervalSeconds: number,
 *   historyDays: number, lastSyncAt?: string, initialSyncDone?: boolean }} UsageConfig
 */

export const DEFAULT_SERVER = 'https://app.ai-adoption-score.app'

export function configDir(env = process.env) {
  return env.AI_ADOPTION_SCORE_HOME || join(homedir(), '.ai-adoption-score')
}

function configPath(env) {
  return join(configDir(env), 'config.json')
}

/** @returns {UsageConfig | null} */
/**
 * Whether `config` is still this Mac's connection: running the line again replaces it while a sync or check-in that
 * read the old one may still be on its way, and that one must neither remove the add-on nor write its settings back.
 */
export function isCurrentConfig(config, env = process.env) {
  return readConfig(env)?.token === config.token
}

export function readConfig(env = process.env) {
  try {
    const config = JSON.parse(readFileSync(configPath(env), 'utf8'))
    return config && typeof config.token === 'string' && typeof config.server === 'string' ? config : null
  } catch {
    return null
  }
}

/** Written through a temporary file, so a crash never leaves half a config. @param {UsageConfig} config */
export function writeConfig(config, env = process.env) {
  const dir = configDir(env)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const path = configPath(env)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

export function removeConfig(env = process.env) {
  const path = configPath(env)
  if (existsSync(path)) rmSync(path)
}
