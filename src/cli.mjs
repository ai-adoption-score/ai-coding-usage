// @ts-check
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLIENT_VERSION, post } from './api.mjs'
import { runCheckIn } from './checkin.mjs'
import { DEFAULT_SERVER, readConfig, writeConfig } from './config.mjs'
import { runHook } from './hook.mjs'
import { hookState, installAll, uninstallAll } from './install.mjs'
import { paths } from './paths.mjs'
import { scanUsage } from './scan.mjs'
import { readState } from './state.mjs'
import { describeChoice, repositoryList } from './choice.mjs'
import { formatSummary } from './summary.mjs'
import { askChoice, syncNow, waitForChoice } from './sync.mjs'

const HELP = `ai-adoption-score: shares how you use Claude Code and Codex with your company's AI Adoption Score survey.
It never shares prompts, AI answers, code, file names, command text or session titles.

Usage
  ai-adoption-score connect <code> [--server <url>]
  ai-adoption-score status
  ai-adoption-score sync
  ai-adoption-score disconnect
  ai-adoption-score preview [--days 30] [--company github.com/acme] [--json]

  connect     Link this Mac to your survey with the code from your survey page. It adds a hook to Claude Code and
              Codex and an automatic ping-back, and sends the names of the repositories you used in the last 30 days, so
              you can choose on your survey page which to share. Then it shares the last 30 days of those, and after
              that, after each session. Run it again to change your choice.
  status      Show which survey this Mac shares with, what you chose, its hooks, and when it last shared.
  sync        Share now, instead of after the next session.
  disconnect  Stop sharing from this Mac: removes the hooks, the ping-back and the add-on's settings.
  preview     Count this Mac's last 30 days and show what would be shared. Nothing is sent.
  --days      How many days back, 1 to 30.
  --company   An account whose repositories are your company's, to mark them. Repeat for more.
  --json      Print the exact rows instead of the summary.
`

const say = (text) => process.stdout.write(`${text}\n`)
const fail = (text) => {
  process.stderr.write(`${text}\n`)
  return 1
}
/** The add-on's own folder: npx's copy when run from npm, this repository's while testing. */
const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** @param {string[]} args @returns {Promise<number>} */
export async function runCli(args) {
  const [command, ...rest] = args
  switch (command) {
    case 'connect':
      return connect(rest)
    case 'status':
      return status()
    case 'sync':
      return sync(rest)
    case 'disconnect':
      return disconnect()
    case 'preview':
      return preview(rest)
    // Run by the hooks and the ping-back (its launchd job still calls it check-in), not by people.
    case 'hook':
      if (rest[0] === 'claude-code' || rest[0] === 'codex') await runHook(rest[0])
      // Exit at once: the sync runs on in its own process, and the tool shouldn't wait for anything here.
      process.exit(0)
    case 'check-in':
      return runCheckIn()
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP)
      return command ? 0 : 1
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`)
      return 1
  }
}

/** The tools whose records are on this Mac. */
function toolsHere(env = process.env) {
  const tools = []
  if (existsSync(join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'))) tools.push('claude-code')
  if (existsSync(join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'))) tools.push('codex')
  return tools
}

const HOOK_WORDS = { added: 'hook added', already: 'hook already there', 'not-used': 'not on this Mac', failed: "couldn't add the hook" }

/** @param {string} left @param {string} right */
function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    return false
  }
}

/** @param {string[]} args */
async function connect(args) {
  let code = null
  let server = process.env.AI_ADOPTION_SCORE_SERVER || DEFAULT_SERVER
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--server') server = args[++index] ?? ''
    else if (!code) code = args[index]
    else return fail(`Unknown option "${args[index]}".`)
  }
  if (!code) return fail('Add the code from your survey page: ai-adoption-score connect K7Q2-9M4X')
  try {
    new URL(server)
  } catch {
    return fail(`"${server}" isn't a web address.`)
  }
  // Run again on a Mac that is connected: the same server carries the link on with the new token, so it doesn't
  // count a second Mac. A token never goes to another server; that survey is told the Mac left once this one connects.
  const previous = readConfig()
  const sameServer = Boolean(previous) && sameOrigin(previous.server, server)
  const response = await post(server, '/api/usage/connect', {
    code,
    platform: process.platform,
    clientVersion: CLIENT_VERSION,
    tools: toolsHere(),
    ...(sameServer ? { replaces: previous.token } : {}),
  })
  if (response.body?.status === 'unsupported') {
    return fail('AI Coding Usage works on a Mac for now. Your company sees that you tried, so it knows you are waiting.')
  }
  if (response.status !== 200 || response.body?.status !== 'connected') {
    return fail(response.body?.error ?? `Couldn't connect: the server answered ${response.status}.`)
  }
  const { token, companyName, syncIntervalSeconds, historyDays } = response.body
  // A new connection starts with nothing sent.
  rmSync(paths().state, { force: true })
  const config = { server, token, companyName, connectedAt: new Date().toISOString(), syncIntervalSeconds, historyDays }
  writeConfig(config)
  if (previous && !sameServer) {
    try {
      await post(previous.server, '/api/usage/disconnect', {}, previous.token)
    } catch {
      // Offline: that survey's page can still disconnect the Mac.
    }
  }
  const installed = installAll({ sourceRoot: SOURCE_ROOT, nodePath: process.execPath })
  say(`Connected to ${companyName}'s survey.`)
  say(`  Claude Code: ${HOOK_WORDS[installed.claude] ?? installed.claude}`)
  say(`  Codex: ${HOOK_WORDS[installed.codex] ?? installed.codex}`)
  say(`  Automatic ping-back: ${installed.checkIn === 'added' ? 'added, so the survey knows this Mac is still connected (no numbers)' : "couldn't add it"}`)
  // The person chooses which repositories to share before any session leaves this Mac: only the names go now.
  const scan = await scanUsage({ days: historyDays || 30 })
  const list = repositoryList(scan.rows)
  const listed = await post(server, '/api/usage/repositories', list, token)
  if (listed.body?.status !== 'choosing') {
    return fail(listed.body?.error ?? `The survey answered "${listed.body?.status ?? listed.status}". Nothing is shared from this Mac.`)
  }
  const found = list.repositories.length
  say(`Found ${found} ${found === 1 ? 'repository' : 'repositories'}${list.outsideGit ? ', and work outside a repository' : ''}, in the last ${historyDays} days.`)
  say('Now choose on your survey page which to share. Nothing from your sessions is sent until you do.')
  say('Then the last 30 days of what you chose are shared, and after that, your numbers after each session.')
  // Waits in the background, so this line returns at once in Claude Code or Codex too.
  const waiter = spawn(process.execPath, [paths().appBin, 'sync', '--background', '--wait-for-choice'], {
    detached: true,
    stdio: 'ignore',
  })
  waiter.unref()
  if (installed.codex === 'added') {
    say('Codex needs your OK once. In the Codex app: Settings → Hooks, then Trust on the three AI Adoption Score hooks.')
    say('Codex in Terminal asks when it starts.')
  }
  return 0
}

/** @param {string[]} args */
async function sync(args) {
  const background = args.includes('--background')
  const reasonAt = args.indexOf('--reason')
  const reason = reasonAt >= 0 ? args[reasonAt + 1] ?? 'manual' : 'manual'
  const config = readConfig()
  if (!config) return background ? 0 : fail('This Mac isn\'t connected. Paste the line from your survey page to connect it.')
  if (background && args.includes('--wait-for-choice')) {
    try {
      await waitForChoice(config)
    } catch {
      // Logged; the next sync after the choice sends everything.
    }
    return 0
  }
  if (background) {
    try {
      await syncNow(config, { background, reason })
    } catch {
      // Logged; the next session tries again.
    }
    return 0
  }
  const result = await syncNow(config, { reason })
  if (result.status === 'revoked') return fail('This Mac was disconnected, so the add-on removed itself. Nothing more is shared.')
  if (result.status === 'closed') return fail(`${config.companyName} stopped collecting, so the add-on removed itself.`)
  if (result.status === 'paused') return fail('The survey is paused. Nothing was sent; the numbers stay on this Mac.')
  if (result.status === 'busy') return fail('Another sync is running. Try again in a minute.')
  if (result.status === 'waiting') return fail('The survey asked to wait a little before the next sync.')
  if (result.rows === 0 && result.accepted === 0) {
    const asked = await askChoice(config).catch(() => null)
    if (asked && !asked.choice) return fail('Nothing is shared yet: choose your repositories on your survey page. Run the line again if the list is gone.')
  }
  say(`Shared ${result.accepted} changed rows (${result.sessions} sessions in the window) with ${config.companyName}.`)
  return 0
}

async function status() {
  const config = readConfig()
  if (!config) {
    say('This Mac isn\'t connected to a survey.')
    return 0
  }
  const state = readState()
  say(`Connected to ${config.companyName}'s survey at ${config.server} since ${config.connectedAt}.`)
  try {
    const asked = await askChoice(config)
    say(`Shares: ${asked.status === 'choosing' && !asked.choice ? 'nothing yet, while you choose on your survey page' : describeChoice(asked.choice)}.`)
  } catch {
    say('Shares: unknown, the survey couldn\'t be reached.')
  }
  say(`Claude Code hook: ${hookState('claude-code')}${state.hookRuns['claude-code'] ? `, last ran ${state.hookRuns['claude-code']}` : ''}`)
  say(`Codex hook: ${hookState('codex')}${state.hookRuns.codex ? `, last ran ${state.hookRuns.codex}` : ''}`)
  say(state.lastSyncAt ? `Last shared: ${state.lastSyncAt}.` : 'Nothing shared yet.')
  if (state.lastCheckInAt) say(`Last ping-back: ${state.lastCheckInAt}.`)
  if (state.lastError) say(`Last problem: ${state.lastError}`)
  return 0
}

async function disconnect() {
  const config = readConfig()
  if (config) {
    try {
      await post(config.server, '/api/usage/disconnect', {}, config.token)
    } catch {
      // Offline: everything is removed anyway, and the survey page can still disconnect the Mac.
    }
  }
  const removed = uninstallAll()
  say(config ? `Disconnected from ${config.companyName}'s survey.` : 'This Mac wasn\'t connected.')
  say(`Removed the hooks${removed.claude || removed.codex ? '' : ' (none were left)'}, the ping-back and the add-on's settings.`)
  return 0
}

/** @param {string[]} rest */
async function preview(rest) {
  let days = 30
  let json = false
  /** @type {string[]} */
  const companyAccounts = []
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index]
    if (option === '--json') json = true
    else if (option === '--days') {
      days = Number(rest[++index])
      if (!Number.isInteger(days) || days < 1 || days > 30) return fail('--days needs a whole number from 1 to 30.')
    } else if (option === '--company') {
      const account = rest[++index]
      if (!account) return fail('--company needs an account, like github.com/acme.')
      companyAccounts.push(account.replace(/^https?:\/\//i, '').replace(/\/+$/, ''))
    } else return fail(`Unknown option "${option}".\n\n${HELP}`)
  }
  if (process.platform !== 'darwin') return fail('AI Coding Usage works on a Mac for now. Nothing was read.')
  const scan = await scanUsage({ days })
  process.stdout.write(json ? `${JSON.stringify({ since: scan.since, until: scan.until, rows: scan.rows }, null, 2)}\n` : `${formatSummary(scan, { companyAccounts })}\n`)
  return 0
}
