// @ts-check
import { homedir } from 'node:os'
import { join } from 'node:path'
import { configDir } from './config.mjs'

/**
 * Where the add-on keeps and puts things. Every place can be moved with an environment variable, so a test never
 * touches the real Claude Code, Codex or launchd settings.
 */

export const CHECK_IN_LABEL = 'app.ai-adoption-score.check-in'
/** Marks our entries in the tools' hook settings: their command runs this launcher. */
export const LAUNCHER_NAME = 'run.sh'

export function paths(env = process.env) {
  const home = configDir(env)
  return {
    home,
    app: join(home, 'app'),
    appBin: join(home, 'app', 'bin', 'ai-adoption-score.mjs'),
    launcher: join(home, LAUNCHER_NAME),
    state: join(home, 'state.json'),
    lock: join(home, 'sync.lock'),
    log: join(home, 'log.txt'),
    claudeSettings: env.AI_ADOPTION_SCORE_CLAUDE_SETTINGS || join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'),
    codexHooks: env.AI_ADOPTION_SCORE_CODEX_HOOKS || join(env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json'),
    launchAgents: env.AI_ADOPTION_SCORE_LAUNCH_AGENTS || join(homedir(), 'Library', 'LaunchAgents'),
    checkInPlist: join(env.AI_ADOPTION_SCORE_LAUNCH_AGENTS || join(homedir(), 'Library', 'LaunchAgents'), `${CHECK_IN_LABEL}.plist`),
    claudeRecords: join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'),
    codexRecords: join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'),
  }
}
