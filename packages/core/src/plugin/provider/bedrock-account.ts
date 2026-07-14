import { AsyncLocalStorage } from "async_hooks"

// Account index for the in-flight request, set by the session LLM middleware and
// read by the per-request credentialProvider below. Pins a session to one account
// (Bedrock prompt caching is per-account, so rotating mid-session cold-misses).
const accountStore = new AsyncLocalStorage<number>()
const assignment = new Map<string, number>()
let cursor = 0

function nextIndex(count: number): number {
  const index = cursor % count
  cursor += 1
  return index
}

// Filter a provider's `profiles` option into a clean ordered list. Shared by the
// loaders (which build the credential chain) and the middleware (which selects +
// logs) so index<->profile stays aligned.
export function bedrockProfiles(options: Record<string, any> | undefined): string[] {
  const raw = options?.profiles
  return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string" && p.length > 0) : []
}

export type AccountSelection = { index: number; profile: string | undefined; newlyAssigned: boolean }

// Sticky per session, global round-robin when there is no session. `newlyAssigned`
// lets the caller log the session->account mapping exactly once per session.
export function selectBedrockAccount(
  providerID: string,
  sessionID: string | undefined,
  profiles: string[],
): AccountSelection {
  const count = profiles.length
  if (count <= 1) return { index: 0, profile: profiles[0], newlyAssigned: false }
  if (sessionID === undefined) {
    const index = nextIndex(count)
    return { index, profile: profiles[index], newlyAssigned: false }
  }
  const key = `${providerID}\0${sessionID}`
  const existing = assignment.get(key)
  if (existing !== undefined && existing < count)
    return { index: existing, profile: profiles[existing], newlyAssigned: false }
  const index = nextIndex(count)
  assignment.set(key, index)
  return { index, profile: profiles[index], newlyAssigned: true }
}

export function withBedrockAccount<R>(index: number, fn: () => R): R {
  return accountStore.run(index, fn)
}

type CredentialProvider<T> = () => Promise<T>

// @ai-sdk/amazon-bedrock calls credentialProvider() on every request. Use the
// account chosen for this request by the middleware; fall back to a global
// round-robin for calls made outside a session context. All profiles must share
// region — the account is determined entirely by the returned credentials.
export function makeAccountRotator<T>(chain: CredentialProvider<T>[]): CredentialProvider<T> {
  return async () => {
    const selected = accountStore.getStore()
    const index =
      selected !== undefined && selected >= 0 && selected < chain.length
        ? selected
        : chain.length > 1
          ? nextIndex(chain.length)
          : 0
    const provider = chain[index]
    if (!provider) throw new Error("Bedrock credential provider chain is empty")
    return provider()
  }
}
