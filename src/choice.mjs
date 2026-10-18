// @ts-check

/**
 * Which repositories the person shares. They choose on their survey page when this Mac connects: the add-on sends the
 * names of the repositories it found, nothing else, and every sync sends only the sessions of what they chose. A new
 * repository is shared when its owner was ticked in full; otherwise it stays on this Mac until they run the line again.
 * The server applies the same rule.
 *
 * @typedef {{ repositories: string[], owners: string[], outsideGit: boolean, localFolders: boolean } | { all: true }} RepositoryChoice
 */

/** A git repository without a remote, named after its folder. */
export const LOCAL_PREFIX = 'local:'

/** The owner of `github.com/acme/app`: `github.com/acme`. None for a folder without a remote. @param {string} repository */
export function repositoryOwner(repository) {
  if (!repository || repository.startsWith(LOCAL_PREFIX)) return null
  const parts = repository.split('/')
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}`.toLowerCase() : null
}

/**
 * Whether a session in `repository` (null outside any repository) is shared. Nothing is, before the person chooses.
 * @param {RepositoryChoice | null} choice @param {string | null} repository
 */
export function isShared(choice, repository) {
  if (!choice) return false
  if ('all' in choice) return true
  if (!repository) return choice.outsideGit
  if (choice.repositories.includes(repository)) return true
  if (repository.startsWith(LOCAL_PREFIX)) return choice.localFolders
  const owner = repositoryOwner(repository)
  return owner !== null && choice.owners.some((ticked) => ticked.toLowerCase() === owner)
}

/** At most this many names go to the page: the most recently used, if there are more. */
const MAX_REPOSITORIES = 500

/**
 * What the person chooses from: the names of the repositories the rows ran in, and whether any work ran outside a
 * repository. Nothing about the sessions themselves.
 * @param {Array<{ repository: string | null, lastEventAt: string }>} rows
 */
export function repositoryList(rows) {
  /** @type {Map<string, string>} */
  const lastUse = new Map()
  let outsideGit = false
  for (const row of rows) {
    if (!row.repository) {
      outsideGit = true
      continue
    }
    const seen = lastUse.get(row.repository)
    if (!seen || row.lastEventAt > seen) lastUse.set(row.repository, row.lastEventAt)
  }
  const repositories = [...lastUse.entries()]
    .sort((left, right) => right[1].localeCompare(left[1]))
    .slice(0, MAX_REPOSITORIES)
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right))
  return { schemaVersion: /** @type {const} */ (1), repositories, outsideGit }
}

/** What this Mac shares, in a line for `status`. @param {RepositoryChoice | null} choice */
export function describeChoice(choice) {
  if (!choice) return 'nothing yet: choose your repositories on your survey page'
  if ('all' in choice) return 'every repository'
  const parts = [`${choice.repositories.length} ${choice.repositories.length === 1 ? 'repository' : 'repositories'}`]
  if (choice.owners.length > 0) parts.push(`new ones from ${choice.owners.join(', ')}`)
  if (choice.outsideGit) parts.push('work outside a repository')
  return parts.join(', ')
}
