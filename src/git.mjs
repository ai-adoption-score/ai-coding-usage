// @ts-check
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname } from 'node:path'

/**
 * What git says about the folders sessions ran in: the repository's address, which branches are pushed, and the
 * person's commits. Only addresses, branch names and commit times are read; never file contents.
 */

/**
 * `git@github.com:Acme/App.git`, `https://user:token@github.com/Acme/App`, `ssh://git@host:22/acme/app.git`
 * → `github.com/Acme/App`, `host/acme/app`. Credentials in an address are dropped.
 */
export function normalizeRemote(url) {
  const trimmed = String(url ?? '').trim()
  if (!trimmed) return null
  let host
  let path
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed
    try {
      parsed = new URL(trimmed)
    } catch {
      return null
    }
    if (parsed.protocol === 'file:') return null
    host = parsed.hostname
    path = parsed.pathname
  } else if (scp) {
    host = scp[1]
    path = scp[2]
  } else {
    return null
  }
  const cleanPath = path.replace(/^\/+/, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  if (!host || !cleanPath) return null
  return `${host.toLowerCase()}/${cleanPath}`
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim()
  } catch {
    return ''
  }
}

/** git lookups, each done once per folder or repository. */
export function createGitInfo() {
  /** @type {Map<string, { repository: string | null, top: string | null }>} */
  const byFolder = new Map()
  /** @type {Map<string, Set<string>>} */
  const remoteBranches = new Map()

  return {
    /** The repository a folder belongs to: its remote's address, `local:<folder>` without a remote, or null outside git. */
    repositoryFor(cwd) {
      if (!cwd) return { repository: null, top: null }
      const cached = byFolder.get(cwd)
      if (cached) return cached
      let result = { repository: /** @type {string | null} */ (null), top: /** @type {string | null} */ (null) }
      // A removed folder, such as a deleted worktree, still belongs to the repository around it, if that remains.
      let folder = cwd
      for (let up = 0; up < 6 && !existsSync(folder); up += 1) folder = dirname(folder)
      if (existsSync(folder)) {
        const top = git(folder, ['rev-parse', '--show-toplevel'])
        if (top) {
          const origin = git(top, ['config', '--get', 'remote.origin.url'])
          const firstRemote = origin || git(top, ['config', '--get-regexp', '^remote\\..*\\.url$']).split('\n')[0]?.split(' ').slice(1).join(' ')
          result = { repository: normalizeRemote(firstRemote) ?? `local:${basename(top)}`, top }
        }
      }
      byFolder.set(cwd, result)
      return result
    },

    /** Whether a branch exists on any remote, as of the last fetch: no network is used. */
    isPushed(top, branch) {
      if (!top || !branch || branch === 'HEAD') return false
      let names = remoteBranches.get(top)
      if (!names) {
        names = new Set(
          git(top, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])
            .split('\n')
            .filter(Boolean)
            .map((ref) => ref.slice(ref.indexOf('/') + 1))
        )
        remoteBranches.set(top, names)
      }
      return names.has(branch)
    },

    /**
     * The person's commits in a repository since a moment: by the repository's `user.email`, with whether each is
     * on a remote yet.
     * @returns {{ time: number, pushed: boolean }[]}
     */
    commitsSince(top, since) {
      const email = git(top, ['config', 'user.email'])
      if (!email) return []
      const sinceArg = `--since=@${Math.floor(since / 1000)}`
      const author = `--author=${email}`
      const pushed = new Set(git(top, ['log', '--remotes', author, sinceArg, '--format=%H']).split('\n').filter(Boolean))
      return git(top, ['log', '--all', author, sinceArg, '--format=%H %ct'])
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, seconds] = line.split(' ')
          return { time: Number(seconds) * 1000, pushed: pushed.has(hash) }
        })
    },
  }
}

/** How long after a session's last moment a commit still counts as that session's. */
const COMMIT_AFTER_MS = 60 * 60_000

/**
 * Gives each commit to one row of its repository: the row whose window, from its first moment to an hour after its
 * last, holds the commit, and whose last moment is nearest to it. A commit outside every window belongs to no row.
 * @param {import('./rows.mjs').RowDraft[]} rows @param {ReturnType<typeof createGitInfo>} gitInfo @param {number} since
 */
export function assignCommits(rows, gitInfo, since) {
  /** @type {Map<string, import('./rows.mjs').RowDraft[]>} */
  const byTop = new Map()
  for (const row of rows) {
    if (!row.gitTop) continue
    byTop.set(row.gitTop, [...(byTop.get(row.gitTop) ?? []), row])
  }
  for (const [top, topRows] of byTop) {
    const windows = topRows.map((row) => ({ row, first: Math.min(...row.times), last: Math.max(...row.times) }))
    for (const commit of gitInfo.commitsSince(top, since)) {
      let best = null
      let bestDistance = Infinity
      for (const window of windows) {
        if (commit.time < window.first || commit.time > window.last + COMMIT_AFTER_MS) continue
        const distance = Math.max(0, commit.time - window.last)
        if (distance < bestDistance) {
          best = window.row
          bestDistance = distance
        }
      }
      if (best) {
        best.commits += 1
        if (commit.pushed) best.commitsPushed += 1
      }
    }
  }
}
