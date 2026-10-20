// @ts-check
import { readClaudeCode } from './claude-code.mjs'
import { readCodex } from './codex.mjs'
import { loadDesktopConnectorNames } from './connectors.mjs'
import { assignCommits, createGitInfo } from './git.mjs'
import { createRowSet, finishRow, hasUse, windowStart } from './rows.mjs'

/** The add-on never reads further back than this, whatever the server asks for. */
export const MAX_HISTORY_DAYS = 30

/** How many days to read: a whole number from 1 to 30, and 30 when `days` isn't one. @param {unknown} days */
export function daysToRead(days) {
  const whole = Math.trunc(Number(days))
  return Number.isFinite(whole) && whole >= 1 ? Math.min(whole, MAX_HISTORY_DAYS) : MAX_HISTORY_DAYS
}

/**
 * Reads this Mac's Claude Code and Codex records for the last `days` calendar days, 30 at most, and returns the rows
 * that would be sent, with how much of the records could be read. Nothing is written and nothing leaves the Mac.
 * @param {{ days?: number, now?: number, env?: NodeJS.ProcessEnv }} [options]
 */
export async function scanUsage({ days = MAX_HISTORY_DAYS, now = Date.now(), env = process.env } = {}) {
  const since = windowStart(now, daysToRead(days))
  const rows = createRowSet()
  const gitInfo = createGitInfo()
  const claudeHealth = { files: 0, lines: 0, unreadable: 0 }
  const codexHealth = { files: 0, lines: 0, unreadable: 0 }

  await readClaudeCode({ since, env, rows, gitInfo, desktopNames: loadDesktopConnectorNames(), health: claudeHealth })
  readCodex({ since, env, rows, gitInfo, health: codexHealth })

  const drafts = rows.drafts().filter(hasUse)
  assignCommits(drafts, gitInfo, since)
  const finished = drafts
    .map((draft) => finishRow(draft, (top, branch) => gitInfo.isPushed(top, branch)))
    .sort((left, right) => left.firstEventAt.localeCompare(right.firstEventAt))

  return {
    since: new Date(since).toISOString(),
    until: new Date(now).toISOString(),
    rows: finished,
    health: { 'claude-code': claudeHealth, codex: codexHealth },
  }
}
