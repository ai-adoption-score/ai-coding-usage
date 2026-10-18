// @ts-check
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { claudeConnectorName } from './connectors.mjs'
import { addConnectorCall, addTokens, changedLines, countLines } from './rows.mjs'

/**
 * Claude Code's records: one file per session under `~/.claude/projects`, and helper agents' files beside them.
 * Each line is read for its kind, time, folder, branch, model and token counts, and for the names of the tools the
 * AI used. Text is only looked at to tell a prompt from a tool result and to count changed lines; it is never kept.
 * Lines holding prompt text or titles (`last-prompt`, `custom-title`, `ai-title`) are skipped without reading them.
 *
 * An edit counts once Claude Code reports it done, with the lines from the diff it stores beside the result. Only
 * edits inside the session's project count: its repository, or its folder outside git. The file's path is used for
 * that check alone and is never kept.
 */

const SKIPPED_TYPES = new Set(['last-prompt', 'custom-title', 'ai-title', 'summary'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const INTERRUPTED = '[Request interrupted by user'
const REJECTED = 'want to proceed with this tool use'

/** Every `.jsonl` file under a folder, changed since `since`. */
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
    else if (entry.name.endsWith('.jsonl')) {
      try {
        if (statSync(path).mtimeMs >= since) found.push(path)
      } catch {
        // Gone between listing and reading.
      }
    }
  }
  return found
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((block) => (block && typeof block.text === 'string' ? block.text : '')).join('\n')
  return ''
}

/**
 * @param {{ since: number, env: NodeJS.ProcessEnv, rows: ReturnType<import('./rows.mjs').createRowSet>,
 *   gitInfo: ReturnType<import('./git.mjs').createGitInfo>, desktopNames: Map<string, string>,
 *   health: { files: number, lines: number, unreadable: number } }} options
 */
export async function readClaudeCode({ since, env, rows, gitInfo, desktopNames, health }) {
  const root = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
  // A resumed or forked session copies earlier lines into a new file: each line, reply and tool call counts once.
  const seenLines = new Set()
  const seenReplies = new Set()
  const seenToolUses = new Set()
  /** Edits waiting for their result. @type {Map<string, { row: import('./rows.mjs').RowDraft, project: string | null, input: Record<string, any>, name: string }>} */
  const pendingEdits = new Map()

  for (const file of recentFiles(root, since)) {
    health.files += 1
    const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line) continue
      health.lines += 1
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        health.unreadable += 1
        continue
      }
      if (!entry || typeof entry !== 'object' || SKIPPED_TYPES.has(entry.type)) continue
      const time = Date.parse(entry.timestamp)
      if (!Number.isFinite(time) || time < since || typeof entry.sessionId !== 'string') continue
      if (typeof entry.uuid === 'string') {
        if (seenLines.has(entry.uuid)) continue
        seenLines.add(entry.uuid)
      }
      if (entry.type !== 'assistant' && entry.type !== 'user') continue

      const { repository, top } = gitInfo.repositoryFor(typeof entry.cwd === 'string' ? entry.cwd : null)
      const row = rows.rowFor({
        tool: 'claude-code',
        sessionId: entry.sessionId,
        time,
        repository,
        // "HEAD" means no branch was checked out, during a rebase for example.
        branch: typeof entry.gitBranch === 'string' && entry.gitBranch && entry.gitBranch !== 'HEAD' ? entry.gitBranch : null,
        gitTop: top,
      })
      const message = entry.message ?? {}

      if (entry.type === 'assistant') {
        const usage = message.usage
        const model = message.model
        // One reply is written as several lines that repeat its usage: count it once.
        const replyKey = `${message.id}|${entry.requestId}`
        if (usage && typeof model === 'string' && model !== '<synthetic>' && !seenReplies.has(replyKey)) {
          seenReplies.add(replyKey)
          addTokens(row, model, {
            input: usage.input_tokens,
            output: usage.output_tokens,
            cacheRead: usage.cache_read_input_tokens,
            cacheWrite: usage.cache_creation_input_tokens,
          })
        }
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue
          if (block.id && seenToolUses.has(block.id)) continue
          if (block.id) seenToolUses.add(block.id)
          if (EDIT_TOOLS.has(block.name) && block.id) {
            const folder = typeof entry.cwd === 'string' ? entry.cwd : null
            pendingEdits.set(block.id, { row, project: top ?? folder, input: block.input ?? {}, name: block.name })
          } else countToolUse(row, block.name, block.input ?? {}, desktopNames)
        }
        continue
      }

      // A user line: a prompt, a stop, or the result of a tool the AI used.
      const content = message.content
      const blocks = Array.isArray(content) ? content : []
      for (const block of blocks) {
        if (block?.type !== 'tool_result') continue
        if (textOf(block.content).includes(REJECTED)) row.rejectedActions += 1
        const edit = pendingEdits.get(block.tool_use_id)
        if (!edit) continue
        pendingEdits.delete(block.tool_use_id)
        // A failed or turned-down edit changed nothing.
        if (!block.is_error) countEdit(edit, entry.toolUseResult)
      }
      // A helper agent's instructions, the app's own notes and a compacted summary are not the person's prompts.
      if (entry.isSidechain || entry.isMeta || entry.isCompactSummary || blocks.some((block) => block?.type === 'tool_result')) continue
      const text = textOf(content).trim()
      if (text.includes(INTERRUPTED)) row.interrupts += 1
      // Slash commands, shell-mode input and the app's notes arrive wrapped in tags such as <command-name>.
      else if ((text && !text.startsWith('<')) || blocks.some((block) => block?.type === 'image')) row.prompts += 1
    }
  }
}

function isInside(path, folder) {
  if (typeof path !== 'string' || !path || !folder) return false
  const file = resolve(path)
  const root = resolve(folder)
  return file === root || file.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/**
 * A finished edit inside the session's project: one file edit, and the lines from the diff Claude Code stored with
 * the result. A new file counts all its lines as added; without a stored diff, the lines are worked out from the edit.
 * @param {{ row: import('./rows.mjs').RowDraft, project: string | null, input: Record<string, any>, name: string }} edit
 * @param {any} result
 */
function countEdit({ row, project, input, name }, result) {
  const path = (result && typeof result === 'object' && result.filePath) || input.file_path || input.notebook_path
  if (!isInside(path, project)) return
  let added = 0
  let removed = 0
  const patch = result && typeof result === 'object' && Array.isArray(result.structuredPatch) ? result.structuredPatch : null
  if (patch && patch.length > 0) {
    for (const hunk of patch) {
      for (const line of Array.isArray(hunk?.lines) ? hunk.lines : []) {
        if (typeof line !== 'string') continue
        if (line.startsWith('+')) added += 1
        else if (line.startsWith('-')) removed += 1
      }
    }
  } else if (result?.type === 'create' || name === 'Write') {
    added = countLines(typeof result?.content === 'string' ? result.content : input.content)
  } else if (name === 'MultiEdit') {
    for (const step of Array.isArray(input.edits) ? input.edits : []) {
      const change = changedLines(step?.old_string, step?.new_string)
      added += change.added
      removed += change.removed
    }
  } else if (name === 'NotebookEdit') {
    added = countLines(input.new_source)
  } else {
    ;({ added, removed } = changedLines(input.old_string, input.new_string))
  }
  row.fileEdits += 1
  row.linesAdded += added
  row.linesRemoved += removed
}

/** @param {import('./rows.mjs').RowDraft} row @param {string} name @param {Record<string, any>} input @param {Map<string, string>} desktopNames */
function countToolUse(row, name, input, desktopNames) {
  switch (name) {
    case 'Bash':
      row.commands += 1
      return
    case 'Task':
    case 'Agent':
      row.helperAgents += 1
      return
    case 'Skill':
      row.skills += 1
      return
    default:
      if (name.startsWith('mcp__')) {
        const connector = claudeConnectorName(name, desktopNames)
        if (connector) addConnectorCall(row, connector)
      }
  }
}
