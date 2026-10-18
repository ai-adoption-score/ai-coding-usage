// @ts-check

/** The preview's summary: what this Mac would share, in a few lines a person can check. */

const TOOL_LABELS = { 'claude-code': 'Claude Code', codex: 'Codex' }

/** "claude-opus-5-5" → "Opus 5.5", "gpt-6-astra" → "GPT-6 Astra"; anything else as written. */
export function modelLabel(model) {
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model)
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/.exec(model)
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ` ${gpt[2].split('-').map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(' ')}` : ''}`
  return model
}

export function formatTokens(value) {
  for (const [size, unit] of /** @type {const} */ ([[1e9, 'B'], [1e6, 'M'], [1e3, 'K']])) {
    if (value >= size) {
      const scaled = value / size
      return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${unit}`
    }
  }
  return String(Math.round(value))
}

const number = (value) => value.toLocaleString('en-US')
const plural = (count, one, many) => `${number(count)} ${count === 1 ? one : many}`

function shortDay(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * @param {Awaited<ReturnType<typeof import('./scan.mjs').scanUsage>>} scan
 * @param {{ companyAccounts?: string[] }} [options]
 */
export function formatSummary(scan, { companyAccounts = [] } = {}) {
  const { rows } = scan
  const out = []
  out.push('AI Adoption Score: what this Mac would share')
  const from = shortDay(scan.since)
  const to = shortDay(scan.until)
  out.push(`${from === to ? from : `${from} to ${to}`}, from the records Claude Code and Codex keep here. Nothing was sent.`)
  out.push('')

  for (const tool of /** @type {const} */ (['claude-code', 'codex'])) {
    const toolRows = rows.filter((row) => row.tool === tool)
    const health = scan.health[tool]
    if (toolRows.length === 0) {
      out.push(`${TOOL_LABELS[tool].padEnd(12)} no sessions found`)
      continue
    }
    const sessions = new Set(toolRows.map((row) => row.sessionKey)).size
    const days = new Set(toolRows.map((row) => row.day)).size
    const replies = new Map()
    let written = 0
    let read = 0
    for (const row of toolRows) {
      for (const [model, tokens] of Object.entries(row.models)) {
        replies.set(model, (replies.get(model) ?? 0) + tokens.replies)
        written += tokens.output
        read += tokens.input + tokens.cacheRead + tokens.cacheWrite
      }
    }
    const allReplies = [...replies.values()].reduce((sum, count) => sum + count, 0)
    const models = [...replies.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([model, count]) => `${modelLabel(model)} ${Math.round((count / Math.max(allReplies, 1)) * 100)}%`)
      .join(', ')
    out.push(`${TOOL_LABELS[tool].padEnd(12)} ${plural(sessions, 'session', 'sessions')} on ${plural(days, 'day', 'days')}`)
    out.push(`${''.padEnd(12)} ${formatTokens(written)} tokens written by the AI, ${formatTokens(read)} read`)
    out.push(`${''.padEnd(12)} ${models}`)
    if (health.unreadable > 0) out.push(`${''.padEnd(12)} ${plural(health.unreadable, 'line', 'lines')} of ${number(health.lines)} couldn't be read`)
  }

  const isCompany = (repository) =>
    Boolean(repository) && companyAccounts.some((account) => repository.toLowerCase().startsWith(`${account.toLowerCase().replace(/\/+$/, '')}/`))
  /** @type {Map<string, { sessions: Set<string>, commits: number, pushed: number, branches: Map<string, boolean> }>} */
  const repositories = new Map()
  for (const row of rows) {
    const key = row.repository ?? 'No repository'
    const entry = repositories.get(key) ?? { sessions: new Set(), commits: 0, pushed: 0, branches: new Map() }
    entry.sessions.add(row.sessionKey)
    entry.commits += row.commits
    entry.pushed += row.commitsPushed
    if (row.branch) entry.branches.set(row.branch, (entry.branches.get(row.branch) ?? false) || row.branchPushed)
    repositories.set(key, entry)
  }
  out.push('')
  out.push('Repositories and branches')
  for (const [repository, entry] of [...repositories.entries()].sort((left, right) => right[1].sessions.size - left[1].sessions.size)) {
    const tag = companyAccounts.length > 0 ? (isCompany(repository) ? '  [company]' : '  [other]') : ''
    out.push(`  ${repository}${tag}`)
    out.push(`    ${plural(entry.sessions.size, 'session', 'sessions')}, ${plural(entry.commits, 'commit', 'commits')} (${number(entry.pushed)} pushed)`)
    const branches = [...entry.branches.entries()].map(([branch, pushed]) => `${branch}${pushed ? '' : ' (not pushed)'}`)
    if (branches.length > 0) out.push(`    ${branches.slice(0, 8).join(', ')}${branches.length > 8 ? `, and ${branches.length - 8} more` : ''}`)
  }

  const connectors = new Map()
  for (const row of rows) for (const [name, calls] of Object.entries(row.connectors)) connectors.set(name, (connectors.get(name) ?? 0) + calls)
  out.push('')
  out.push(
    connectors.size === 0
      ? 'Connectors: none used'
      : `Connectors: ${[...connectors.entries()].sort((left, right) => right[1] - left[1]).map(([name, calls]) => `${name} ${number(calls)}`).join(', ')}`
  )

  const total = (key) => rows.reduce((sum, row) => sum + row[key], 0)
  out.push(
    `Also counted: ${plural(total('prompts'), 'prompt', 'prompts')}, ${plural(total('commands'), 'command', 'commands')}, ` +
      `${plural(total('fileEdits'), 'file edit', 'file edits')} (+${number(total('linesAdded'))} −${number(total('linesRemoved'))} lines), ` +
      `${plural(total('helperAgents'), 'helper agent', 'helper agents')}, ${plural(total('skills'), 'skill', 'skills')}, ` +
      `${plural(total('interrupts'), 'stop', 'stops')}, ${plural(total('rejectedActions'), 'rejected action', 'rejected actions')}.`
  )
  out.push('')
  out.push('Never shared: prompts, AI answers, code, file names and paths, command text, session titles.')
  out.push('Add --json to see the exact rows.')
  return out.join('\n')
}
