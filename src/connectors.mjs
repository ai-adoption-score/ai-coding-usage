// @ts-check
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Connector names. A connector is a tool the AI reached that someone connected: GitHub, Linear, Notion. The apps' own
 * built-in tools (the desktop app's browser and terminal, its session tools, Codex's code runners) are not connectors
 * and aren't counted.
 */

/** Built-in tools of the Claude apps, by their server name. */
const CLAUDE_BUILT_IN = new Set([
  'Claude_Browser',
  'Claude_Code_iOS_Simulator',
  'claude-in-chrome',
  'computer-use',
  'ide',
  'mcp-registry',
  'scheduled-tasks',
  'terminal',
  'visualize',
])

/** Codex's own tool servers, which carry no app name. */
const CODEX_BUILT_IN = new Set(['codex_app', 'cua_repl', 'dataAnalyticsWidgets', 'node_repl'])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The Claude desktop app names its claude.ai connectors by id in the tools it gives Claude. Their names are in the
 * app's session files, in `remoteMcpServersConfig`. Only that list is read; everything else in those files, such as
 * session titles, is skipped and never kept.
 * @returns {Map<string, string>}
 */
export function loadDesktopConnectorNames(home = homedir()) {
  const names = new Map()
  const base = join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
  /** @type {{ path: string, modified: number }[]} */
  const files = []
  const list = (dir) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }
  for (const organization of list(base)) {
    for (const account of list(join(base, organization))) {
      for (const file of list(join(base, organization, account))) {
        if (!file.startsWith('local_') || !file.endsWith('.json')) continue
        const path = join(base, organization, account, file)
        try {
          files.push({ path, modified: statSync(path).mtimeMs })
        } catch {
          // Gone between listing and reading.
        }
      }
    }
  }
  // The newest sessions know the current connectors; older ones may name removed ones.
  files.sort((left, right) => right.modified - left.modified)
  for (const { path } of files) {
    try {
      const config = JSON.parse(readFileSync(path, 'utf8')).remoteMcpServersConfig
      if (!Array.isArray(config)) continue
      for (const entry of config) {
        if (entry && typeof entry.uuid === 'string' && typeof entry.name === 'string' && !names.has(entry.uuid)) {
          names.set(entry.uuid, entry.name.trim())
        }
      }
    } catch {
      // Not readable or not JSON: skip it.
    }
  }
  return names
}

/**
 * The connector behind a Claude Code tool name (`mcp__<server>__<tool>`), or null for a built-in tool.
 * @param {string} toolName @param {Map<string, string>} desktopNames
 */
export function claudeConnectorName(toolName, desktopNames) {
  const server = toolName.slice('mcp__'.length).split('__')[0]
  if (!server || CLAUDE_BUILT_IN.has(server) || server.startsWith('ccd_')) return null
  if (UUID.test(server)) return desktopNames.get(server) ?? 'Unnamed connector'
  if (server.startsWith('claude_ai_')) return server.slice('claude_ai_'.length).replaceAll('_', ' ')
  // A plugin's server: `plugin_<plugin>_<server>`.
  const plugin = /^plugin_[^_]+_(.+)$/.exec(server)
  return capitalized(plugin ? plugin[1] : server)
}

/** `figma` → `Figma`; a name with capitals or other signs, such as `ai-adoption-local`, stays as written. */
function capitalized(name) {
  return /^[a-z][a-z0-9]*$/.test(name) ? `${name[0].toUpperCase()}${name.slice(1)}` : name
}

/**
 * The connector behind a Codex connector call: the app's name for ChatGPT apps, else the server's name, or null for
 * Codex's own tools.
 * @param {{ server?: unknown, appName?: unknown }} item
 */
export function codexConnectorName(item) {
  if (typeof item.appName === 'string' && item.appName.trim()) return item.appName.trim()
  const server = typeof item.server === 'string' ? item.server : ''
  if (!server || CODEX_BUILT_IN.has(server) || server === 'codex_apps') return null
  return capitalized(server)
}
