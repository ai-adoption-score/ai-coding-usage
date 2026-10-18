// @ts-check
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { codexConnectorName } from './connectors.mjs'
import { normalizeRemote } from './git.mjs'
import { addConnectorCall, addTokens } from './rows.mjs'

/**
 * Codex's records: one file per thread under `~/.codex/sessions/YYYY/MM/DD`. Each line is read for its kind, time,
 * folder, repository, branch, model and token counts, and for the names of the tools and connectors used. Message
 * text is never kept. `session_index.jsonl`, which holds thread names, is never opened.
 *
 * A thread that Codex starts on its own, such as its automatic reviewer, belongs to the session that started it:
 * its tokens count there, but it adds no session and no prompts.
 */

const COMMAND_TOOLS = new Set(['exec_command', 'shell', 'local_shell', 'container.exec'])
const PATCH_START = '*** Begin Patch'

function recentFiles(dir, since, found = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) recentFiles(path, since, found)
    else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      try {
        if (statSync(path).mtimeMs >= since) found.push(path)
      } catch {
        // Gone between listing and reading.
      }
    }
  }
  return found
}

/** The patch inside a tool call's input or arguments, which may be JSON holding it in one of its fields. */
function patchText(value) {
  if (typeof value !== 'string' || !value.includes(PATCH_START)) return null
  if (value.trimStart().startsWith('{')) {
    try {
      const found = []
      const walk = (node) => {
        if (typeof node === 'string' && node.includes(PATCH_START)) found.push(node)
        else if (node && typeof node === 'object') Object.values(node).forEach(walk)
      }
      walk(JSON.parse(value))
      if (found.length > 0) return found.join('\n')
    } catch {
      // Not JSON after all: read it as it is.
    }
  }
  return value
}

/** Files and lines a patch changes; only the counts are kept. @param {import('./rows.mjs').RowDraft} row */
function countPatch(row, patch) {
  let files = 0
  let inside = false
  for (const line of patch.split('\n')) {
    if (line.startsWith(PATCH_START)) inside = true
    else if (line.startsWith('*** End Patch')) inside = false
    else if (!inside) continue
    else if (/^\*\*\* (Add|Update|Delete) File:/.test(line)) files += 1
    else if (line.startsWith('+') && !line.startsWith('+++')) row.linesAdded += 1
    else if (line.startsWith('-') && !line.startsWith('---')) row.linesRemoved += 1
  }
  row.fileEdits += Math.max(files, 1)
}

const TOKEN_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']

/** Codex's input count includes the cached part; the report keeps them apart, as Claude Code does. */
function tokensOf(usage) {
  const number = (key) => (Number.isFinite(usage?.[key]) ? Number(usage[key]) : 0)
  return {
    input: number('input_tokens') - number('cached_input_tokens'),
    cacheRead: number('cached_input_tokens'),
    cacheWrite: number('cache_write_input_tokens'),
    output: number('output_tokens'),
    reasoning: number('reasoning_output_tokens'),
  }
}

/**
 * @param {{ since: number, env: NodeJS.ProcessEnv, rows: ReturnType<import('./rows.mjs').createRowSet>,
 *   gitInfo: ReturnType<import('./git.mjs').createGitInfo>, health: { files: number, lines: number, unreadable: number } }} options
 */
export function readCodex({ since, env, rows, gitInfo, health }) {
  const root = join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')
  const seenResponses = new Set()

  for (const file of recentFiles(root, since)) {
    health.files += 1
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    // Newer Codex writes one token record per reply and a typed record for each finished item; older Codex only
    // running totals and tool calls. Each file is counted the way it was written.
    const hasTokenRecords = text.includes('"token_usage_record"')
    const hasUserItems = text.includes('"UserMessage"')
    const hasConnectorItems = text.includes('"McpToolCall"')
    const state = {
      sessionId: /** @type {string | null} */ (null),
      startedByCodex: false,
      repository: /** @type {string | null} */ (null),
      top: /** @type {string | null} */ (null),
      branch: /** @type {string | null} */ (null),
      model: 'unknown',
      totals: /** @type {Record<string, number> | null} */ (null),
    }

    for (const line of text.split('\n')) {
      if (!line) continue
      health.lines += 1
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        health.unreadable += 1
        continue
      }
      const payload = entry?.payload ?? {}
      const time = Date.parse(entry?.timestamp)

      if (entry?.type === 'session_meta') {
        state.sessionId = payload.parent_thread_id || payload.id || state.sessionId
        state.startedByCodex = Boolean(payload.parent_thread_id) || (payload.source !== null && typeof payload.source === 'object')
        const folder = gitInfo.repositoryFor(typeof payload.cwd === 'string' ? payload.cwd : null)
        state.repository = normalizeRemote(payload.git?.repository_url) ?? folder.repository
        state.top = folder.top
        state.branch = typeof payload.git?.branch === 'string' && payload.git.branch && payload.git.branch !== 'HEAD' ? payload.git.branch : null
        continue
      }
      if (entry?.type === 'turn_context') {
        if (typeof payload.model === 'string' && payload.model) state.model = payload.model
        continue
      }
      if (!state.sessionId) continue
      const inWindow = Number.isFinite(time) && time >= since
      const row = () =>
        rows.rowFor({ tool: 'codex', sessionId: /** @type {string} */ (state.sessionId), time, repository: state.repository, branch: state.branch, gitTop: state.top })

      // Running totals are followed from the file's first line, so the first counted reply is a difference too.
      if (entry.type === 'event_msg' && payload.type === 'token_count' && !hasTokenRecords) {
        const totals = payload.info?.total_token_usage
        if (totals && typeof totals === 'object') {
          const previous = state.totals
          state.totals = totals
          const delta = Object.fromEntries(TOKEN_FIELDS.map((key) => [key, (Number(totals[key]) || 0) - (Number(previous?.[key]) || 0)]))
          if (inWindow && delta.total_tokens > 0) addTokens(row(), state.model, tokensOf(delta))
        }
        continue
      }
      if (!inWindow) continue

      if (entry.type === 'token_usage_record') {
        const key = payload.response_id
        if (!payload.usage || (key && seenResponses.has(key))) continue
        if (key) seenResponses.add(key)
        addTokens(row(), state.model, tokensOf(payload.usage))
      } else if (entry.type === 'event_msg') {
        if (payload.type === 'turn_aborted' && !state.startedByCodex) row().interrupts += 1
        else if (payload.type === 'task_started' && !hasUserItems && !state.startedByCodex) row().prompts += 1
        else if (payload.type === 'item_completed') {
          const item = payload.item ?? {}
          if (item.type === 'UserMessage' && !state.startedByCodex) row().prompts += 1
          else if (item.type === 'McpToolCall') {
            const name = codexConnectorName(item)
            if (name) addConnectorCall(row(), name)
          }
        }
      } else if (entry.type === 'response_item') {
        if (payload.type === 'function_call' && typeof payload.name === 'string') {
          const patch = patchText(payload.arguments)
          if (payload.name === 'spawn_agent') row().helperAgents += 1
          else if (COMMAND_TOOLS.has(payload.name)) {
            if (patch) countPatch(row(), patch)
            else row().commands += 1
          } else if (!hasConnectorItems && payload.name.includes('__')) {
            // Older Codex names a connector's tools `<server>__<tool>`.
            const name = codexConnectorName({ server: payload.name.split('__')[0] })
            if (name) addConnectorCall(row(), name)
          }
        } else if (payload.type === 'custom_tool_call' && typeof payload.name === 'string') {
          const patch = patchText(payload.input)
          if (payload.name === 'apply_patch' && patch) countPatch(row(), patch)
          else if (payload.name === 'exec') {
            if (patch) countPatch(row(), patch)
            else row().commands += 1
          }
        } else if (payload.type === 'local_shell_call') row().commands += 1
      }
    }
  }
}
