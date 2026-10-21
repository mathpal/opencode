/**
 * Multi-account Bedrock load distribution (mathpal fork).
 *
 * A pool spreads Bedrock traffic across named AWS profiles so parallel
 * subagents draw on several accounts' throughput quotas. Each opencode session
 * stays on the profile it first drew, keeping that account's prompt cache warm;
 * new sessions round-robin across the pool. Requests without a session id take
 * the next profile in turn and are not pinned.
 */

export interface Selection {
  readonly index: number
  readonly profile: string
  /** True for the pool's first selection in this process, so callers log the pool once. */
  readonly first: boolean
  /** True when this call pinned a new session to `profile`. */
  readonly assigned: boolean
}

export interface Pool {
  readonly profiles: readonly string[]
  readonly select: (sessionID: string | undefined) => Selection
}

/** Pinned sessions remembered per pool; the least recently used one is forgotten first. */
export const STICKY_CAPACITY = 4096

export const makePool = (profiles: readonly string[], capacity = STICKY_CAPACITY): Pool => {
  if (profiles.length === 0) throw new Error("Bedrock account pool requires at least one profile")
  const sticky = new Map<string, number>()
  let cursor = 0
  let used = false
  const next = () => {
    const index = cursor
    cursor = (cursor + 1) % profiles.length
    return index
  }
  const selection = (index: number, first: boolean, assigned: boolean): Selection => ({
    index,
    profile: profiles[index],
    first,
    assigned,
  })
  return {
    profiles,
    select: (sessionID) => {
      const first = !used
      used = true
      if (sessionID === undefined) return selection(next(), first, false)
      const pinned = sticky.get(sessionID)
      if (pinned !== undefined) {
        // Re-insert so Map order tracks recency.
        sticky.delete(sessionID)
        sticky.set(sessionID, pinned)
        return selection(pinned, first, false)
      }
      const index = next()
      sticky.set(sessionID, index)
      if (sticky.size > capacity) {
        const oldest = sticky.keys().next()
        if (!oldest.done) sticky.delete(oldest.value)
      }
      return selection(index, first, true)
    },
  }
}

const pools = new Map<string, Pool>()

/** The process-wide pool for this profile list, shared by every model built from the same settings. */
export const pool = (profiles: readonly string[]): Pool => {
  const key = profiles.join("\n")
  const existing = pools.get(key)
  if (existing !== undefined) return existing
  const created = makePool(profiles)
  pools.set(key, created)
  return created
}

/** Keeps configured order; drops non-strings, blanks, and duplicates. */
export const normalizeProfiles = (input: unknown): string[] =>
  Array.isArray(input)
    ? Array.from(
        new Set(
          input
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter((item) => item !== ""),
        ),
      )
    : []

export interface Expiring {
  readonly expiration?: Date
}

/** Cached credentials are refreshed this long before they expire. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000

export interface IdentityCache<A extends Expiring> {
  readonly get: (key: string, load: () => Promise<A>) => Promise<A>
}

export const makeIdentityCache = <A extends Expiring>(
  options: { readonly now?: () => number; readonly marginMs?: number } = {},
): IdentityCache<A> => {
  const now = options.now ?? Date.now
  const margin = options.marginMs ?? REFRESH_MARGIN_MS
  const entries = new Map<string, { readonly value: Promise<A>; refreshAt: number }>()
  return {
    get: (key, load) => {
      const cached = entries.get(key)
      if (cached !== undefined && now() < cached.refreshAt) return cached.value
      // Concurrent callers share the in-flight load until it settles.
      const entry = { value: load(), refreshAt: Number.POSITIVE_INFINITY }
      entries.set(key, entry)
      entry.value.then(
        (identity) => {
          // Without an expiration (static keys that may be rewritten on disk), re-read on every call.
          entry.refreshAt = identity.expiration === undefined ? 0 : identity.expiration.getTime() - margin
        },
        () => {
          if (entries.get(key) === entry) entries.delete(key)
        },
      )
      return entry.value
    },
  }
}

export * as BedrockAccount from "./bedrock-account.js"
