// @ts-check
import { createHash } from 'node:crypto'

/**
 * One session, on one day, in one repository and branch: the row the add-on sends ("What a row holds" in the README).
 * It names no person: the server knows whose it is from the device token.
 *
 * @typedef {'claude-code' | 'codex'} Tool
 * @typedef {{ replies: number, input: number, output: number, cacheRead: number, cacheWrite: number, reasoning: number }} ModelTokens
 * @typedef {{
 *   tool: Tool, sessionKey: string, day: string, firstEventAt: string, lastEventAt: string,
 *   repository: string | null, branch: string | null, branchPushed: boolean, activeMinutes: number,
 *   prompts: number, interrupts: number, rejectedActions: number, commands: number, fileEdits: number,
 *   linesAdded: number, linesRemoved: number, connectors: Record<string, number>, skills: number,
 *   helperAgents: number, commits: number, commitsPushed: number, models: Record<string, ModelTokens>
 * }} UsageRow
 *
 * What a row collects before it is finished; `gitTop` and `times` never leave the Mac.
 * @typedef {Omit<UsageRow, 'sessionKey' | 'firstEventAt' | 'lastEventAt' | 'activeMinutes' | 'branchPushed'> & {
 *   sessionId: string, gitTop: string | null, times: number[]
 * }} RowDraft
 */

/** Gaps shorter than this count as working time. */
const ACTIVE_GAP_MS = 5 * 60_000

/** `YYYY-MM-DD` of a moment, in the Mac's own time zone. */
export function localDay(ms) {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Midnight, local time, `days - 1` days before today: the start of a window of `days` calendar days. */
export function windowStart(now, days) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  return start.getTime()
}

/** Rows keyed by tool, session, day, repository and branch. */
export function createRowSet() {
  /** @type {Map<string, RowDraft>} */
  const rows = new Map()
  return {
    /**
     * The row for one moment of a session, created on first use.
     * @param {{ tool: Tool, sessionId: string, time: number, repository: string | null, branch: string | null, gitTop: string | null }} where
     */
    rowFor({ tool, sessionId, time, repository, branch, gitTop }) {
      const day = localDay(time)
      const key = [tool, sessionId, day, repository ?? '', branch ?? ''].join('\u0000')
      let row = rows.get(key)
      if (!row) {
        row = {
          tool, sessionId, day, repository, branch, gitTop, times: [],
          prompts: 0, interrupts: 0, rejectedActions: 0, commands: 0, fileEdits: 0, linesAdded: 0, linesRemoved: 0,
          connectors: {}, skills: 0, helperAgents: 0, commits: 0, commitsPushed: 0, models: {},
        }
        rows.set(key, row)
      }
      row.times.push(time)
      return row
    },
    drafts() {
      return [...rows.values()]
    },
  }
}

/** @param {RowDraft} row @param {string} model @param {Partial<ModelTokens>} tokens */
export function addTokens(row, model, tokens) {
  const entry = (row.models[model] ??= { replies: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
  entry.replies += tokens.replies ?? 1
  entry.input += Math.max(0, tokens.input ?? 0)
  entry.output += Math.max(0, tokens.output ?? 0)
  entry.cacheRead += Math.max(0, tokens.cacheRead ?? 0)
  entry.cacheWrite += Math.max(0, tokens.cacheWrite ?? 0)
  entry.reasoning += Math.max(0, tokens.reasoning ?? 0)
}

/** @param {RowDraft} row @param {string} name */
export function addConnectorCall(row, name) {
  row.connectors[name] = (row.connectors[name] ?? 0) + 1
}

/** Lines in a piece of text, a final newline not counting as one more. */
export function countLines(text) {
  if (typeof text !== 'string' || text === '') return 0
  const parts = text.split('\n')
  return text.endsWith('\n') ? parts.length - 1 : parts.length
}

/**
 * Lines added and removed between two texts: the lines they share at the start and the end don't count. Only the
 * numbers leave this function, never the text.
 */
export function changedLines(before, after) {
  const oldLines = typeof before === 'string' && before !== '' ? before.split('\n') : []
  const newLines = typeof after === 'string' && after !== '' ? after.split('\n') : []
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1
    newEnd -= 1
  }
  return { added: newEnd - start, removed: oldEnd - start }
}

/** Working time: the gaps between a row's moments that are shorter than five minutes, added up. */
function activeMinutes(times) {
  if (times.length === 0) return 0
  let total = 0
  for (let index = 1; index < times.length; index += 1) {
    const gap = times[index] - times[index - 1]
    if (gap < ACTIVE_GAP_MS) total += gap
  }
  return Math.max(1, Math.round(total / 60_000))
}

/**
 * The finished row. The session id is hashed, so the raw id never leaves the Mac.
 * @param {RowDraft} draft @param {(gitTop: string | null, branch: string | null) => boolean} isPushed
 * @returns {UsageRow}
 */
export function finishRow(draft, isPushed) {
  const times = [...draft.times].sort((left, right) => left - right)
  const { sessionId, gitTop, times: _times, ...rest } = draft
  return {
    ...rest,
    sessionKey: createHash('sha256').update(`${draft.tool}:${sessionId}`).digest('hex').slice(0, 32),
    firstEventAt: new Date(times[0]).toISOString(),
    lastEventAt: new Date(times[times.length - 1]).toISOString(),
    branchPushed: isPushed(gitTop, draft.branch),
    activeMinutes: activeMinutes(times),
  }
}

/** Whether a row has anything worth sending: a reply from the AI or a prompt from the person. */
export function hasUse(row) {
  return row.prompts > 0 || Object.values(row.models).some((model) => model.replies > 0)
}
