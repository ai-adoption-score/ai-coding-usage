// @ts-check
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { paths } from './paths.mjs'

const KEEP_LINES = 300

/** One line in `~/.ai-adoption-score/log.txt`, with the time: what the add-on did, never what was in the records. */
export function log(message, env = process.env) {
  try {
    const path = paths(env).log
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    appendFileSync(path, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 })
    const lines = readFileSync(path, 'utf8').split('\n')
    if (lines.length > KEEP_LINES * 2) writeFileSync(path, lines.slice(-KEEP_LINES).join('\n'), { mode: 0o600 })
  } catch {
    // A log that can't be written mustn't stop anything.
  }
}
