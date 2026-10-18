// @ts-check
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CHECK_IN_LABEL, LAUNCHER_NAME, paths } from './paths.mjs'

/**
 * Putting the add-on in place, and taking it away again:
 * - a copy of itself in `~/.ai-adoption-score/app`, because a hook can't depend on npx's temporary folder;
 * - `run.sh`, which finds Node for the hooks (desktop apps don't load the shell's PATH);
 * - a hook in Claude Code's and Codex's user settings, added after the hooks already there, so nothing else moves and
 *   Codex keeps trusting the hooks it already trusts;
 * - the hourly check-in, a launchd agent.
 * Our hook entries are the ones whose command runs our `run.sh`; nothing else in those files is changed.
 */

/** Events that start a sync: after each reply or turn, when a session starts (to catch up) and when it ends. */
const CLAUDE_EVENTS = ['SessionStart', 'Stop', 'SessionEnd']
const CODEX_EVENTS = ['SessionStart', 'Stop', 'SessionEnd']
/** Codex allows a SessionEnd hook three seconds at most. The hook itself returns in well under one. */
const TIMEOUTS = { SessionStart: 10, Stop: 10, SessionEnd: 3 }
/**
 * The name Codex shows for our hooks in Settings → Hooks, where people trust them. Codex shows it while a hook runs
 * only after 300 ms, and ours returns in about 40, so it never flashes up.
 */
const CODEX_HOOK_NAME = 'AI Adoption Score'

/** Single quotes for the shell the tools run hooks in. */
const quoted = (text) => `'${text.replace(/'/g, `'\\''`)}'`

/**
 * The exact command our hooks run. It never changes between versions: Codex trusts a hook by its command, timeout and
 * name. If the add-on's folder was deleted by hand, it does nothing, so the tools don't show a hook error in every session.
 */
export function hookCommand(tool, env = process.env) {
  const launcher = quoted(paths(env).launcher)
  return `test -f ${launcher} && /bin/sh ${launcher} hook ${tool} || true`
}

function isOurs(hook, env) {
  return typeof hook?.command === 'string' && hook.command.includes(`${paths(env).home}/${LAUNCHER_NAME}`)
}

function readJson(path) {
  return readJsonFile(path).value
}

/** A settings file and its text, `{}` when it doesn't exist yet. */
function readJsonFile(path) {
  if (!existsSync(path)) return { value: {}, text: '' }
  const text = readFileSync(path, 'utf8')
  return { value: JSON.parse(text), text }
}

/**
 * JSON in the style the file already has, so that taking our hook out again leaves it byte for byte as it was: its
 * indent, its last newline, and \u escapes when the file escapes everything outside ASCII (Python's json does).
 * @param {string} previous the file's text before, '' for a new file
 */
export function formatLike(previous, value) {
  const trimmed = previous.trim()
  const indent = /\n([ \t]+)\S/.exec(previous)?.[1] ?? (trimmed && !trimmed.includes('\n') ? '' : '  ')
  let text = JSON.stringify(value, null, indent)
  if (/\\u[0-9a-fA-F]{4}/.test(previous) && !/[^\x00-\x7e]/.test(previous)) {
    text = text.replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
  }
  return previous === '' || previous.endsWith('\n') ? `${text}\n` : text
}

/**
 * Written through a temporary file in the same folder, keeping the file's own permissions and style. A settings file
 * kept as a link, say into a dotfiles repository, stays a link: the file it points to is the one written.
 */
function writeJson(path, value, previous) {
  const target = existsSync(path) ? realpathSync(path) : path
  mkdirSync(dirname(target), { recursive: true })
  let mode = 0o644
  try {
    mode = statSync(target).mode & 0o777
  } catch {
    // A new file.
  }
  const temporary = `${target}.ai-adoption-score.${process.pid}.tmp`
  writeFileSync(temporary, formatLike(previous, value), { mode })
  renameSync(temporary, target)
}

/**
 * Adds our hook to a tool's settings file, after its existing hooks.
 * @returns {'added' | 'already' | 'failed'}
 */
function addHooks(path, events, tool, env) {
  let settings
  let previous
  try {
    ;({ value: settings, text: previous } = readJsonFile(path))
  } catch {
    // Not JSON we can read: leave the person's file alone.
    return 'failed'
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'failed'
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks : {}
  let changed = false
  for (const event of events) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : []
    const present = groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some((hook) => isOurs(hook, env)))
    if (present) continue
    const hook = { type: 'command', command: hookCommand(tool, env), timeout: TIMEOUTS[event] }
    groups.push({ hooks: [tool === 'codex' ? { ...hook, statusMessage: CODEX_HOOK_NAME } : hook] })
    hooks[event] = groups
    changed = true
  }
  if (!changed) return 'already'
  settings.hooks = hooks
  writeJson(path, settings, previous)
  return 'added'
}

/** Takes our hook out of a tool's settings file, and nothing else. */
function removeHooks(path, env) {
  let settings
  let previous
  try {
    ;({ value: settings, text: previous } = readJsonFile(path))
  } catch {
    return false
  }
  if (!settings?.hooks || typeof settings.hooks !== 'object') return false
  let changed = false
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue
    const kept = []
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) {
        kept.push(group)
        continue
      }
      const hooks = group.hooks.filter((hook) => !isOurs(hook, env))
      if (hooks.length !== group.hooks.length) changed = true
      if (hooks.length > 0) kept.push({ ...group, hooks })
    }
    if (kept.length > 0) settings.hooks[event] = kept
    else delete settings.hooks[event]
  }
  if (!changed) return false
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks
  writeJson(path, settings, previous)
  return true
}

/** Whether our hook is in a tool's settings: `installed`, `missing`, or `not-used` when the tool has no records here. */
export function hookState(tool, env = process.env) {
  const where = paths(env)
  const records = tool === 'claude-code' ? where.claudeRecords : where.codexRecords
  const settings = tool === 'claude-code' ? where.claudeSettings : where.codexHooks
  let present = false
  try {
    const hooks = readJson(settings).hooks ?? {}
    present = Object.values(hooks).some(
      (groups) => Array.isArray(groups) && groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some((hook) => isOurs(hook, env)))
    )
  } catch {
    present = false
  }
  if (present) return 'installed'
  return existsSync(records) ? 'missing' : 'not-used'
}

/**
 * The launcher the hooks and the check-in run. It tries the Node that installed it first, then the usual places, and
 * prints nothing and fails nothing if it finds none.
 */
function launcherScript(nodePath, env) {
  const where = paths(env)
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
  return `#!/bin/sh
# AI Adoption Score add-on (AI Coding Usage): starts Node for the hooks and the hourly check-in.
# Desktop apps don't load the shell's PATH, so it looks for Node itself. It prints nothing and never fails the tool.
APP=${quote(where.appBin)}
[ -f "$APP" ] || exit 0
ok() { [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>18||(a===18&&b>=17)?0:1)' >/dev/null 2>&1; }
INSTALLED=${quote(nodePath)}
if [ -x "$INSTALLED" ]; then exec "$INSTALLED" "$APP" "$@"; fi
for NODE in "$AI_ADOPTION_SCORE_NODE" "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME/.local/share/mise/shims/node" "$HOME/.asdf/shims/node" $(ls -1dr "$HOME"/.nvm/versions/node/v*/bin/node "$HOME"/.local/share/fnm/node-versions/v*/installation/bin/node 2>/dev/null); do
  if ok "$NODE"; then exec "$NODE" "$APP" "$@"; fi
done
exit 0
`
}

function checkInPlist(env) {
  const where = paths(env)
  const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${CHECK_IN_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${escape(where.launcher)}</string>
    <string>check-in</string>
  </array>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`
}

function launchctl(args, env) {
  if (env.AI_ADOPTION_SCORE_SKIP_LAUNCHCTL === '1') return true
  try {
    execFileSync('launchctl', args, { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

const domain = () => `gui/${process.getuid?.() ?? 501}`

/**
 * Puts everything in place. `sourceRoot` is the add-on's own folder (npx's copy, or this repository's while testing).
 * @returns {{ claude: string, codex: string, checkIn: string }}
 */
export function installAll({ sourceRoot, nodePath }, env = process.env) {
  const where = paths(env)
  mkdirSync(where.home, { recursive: true, mode: 0o700 })
  chmodSync(where.home, 0o700)
  // A fresh copy of the add-on beside the old one, then swapped in.
  const fresh = `${where.app}.new`
  rmSync(fresh, { recursive: true, force: true })
  for (const part of ['bin', 'src', 'package.json']) cpSync(join(sourceRoot, part), join(fresh, part), { recursive: true })
  rmSync(where.app, { recursive: true, force: true })
  renameSync(fresh, where.app)
  writeFileSync(where.launcher, launcherScript(nodePath, env), { mode: 0o700 })

  const claude = existsSync(where.claudeRecords) || existsSync(where.claudeSettings) ? addHooks(where.claudeSettings, CLAUDE_EVENTS, 'claude-code', env) : 'not-used'
  const codex = existsSync(where.codexRecords) || existsSync(where.codexHooks) ? addHooks(where.codexHooks, CODEX_EVENTS, 'codex', env) : 'not-used'

  mkdirSync(where.launchAgents, { recursive: true })
  writeFileSync(where.checkInPlist, checkInPlist(env), { mode: 0o644 })
  launchctl(['bootout', `${domain()}/${CHECK_IN_LABEL}`], env)
  const checkIn = launchctl(['bootstrap', domain(), where.checkInPlist], env) ? 'added' : 'failed'
  return { claude, codex, checkIn }
}

/** Takes everything away: our hooks, the check-in, and the add-on's own folder with its settings and token. */
export function uninstallAll(env = process.env) {
  const where = paths(env)
  const claude = removeHooks(where.claudeSettings, env)
  const codex = removeHooks(where.codexHooks, env)
  rmSync(where.checkInPlist, { force: true })
  rmSync(where.home, { recursive: true, force: true })
  // Last: when the check-in itself is removing the add-on, unloading it ends this process.
  launchctl(['bootout', `${domain()}/${CHECK_IN_LABEL}`], env)
  return { claude, codex }
}
