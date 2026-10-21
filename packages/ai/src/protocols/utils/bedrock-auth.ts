import { AwsV4Signer } from "aws4fetch"
import { Effect, Option } from "effect"
import { Headers } from "effect/http"
import { Auth, type AuthInput } from "../../route/auth.js"
import { AIError, AuthenticationError } from "../../schema/index.js"
import { ProviderShared } from "../shared.js"
import { BedrockAccount } from "./bedrock-account.js"

/**
 * AWS credentials for SigV4 signing. Bedrock also supports Bearer API key auth,
 * which provider facades configure as route auth instead of SigV4.
 */
export interface Credentials {
  readonly region: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
}

/** Static credentials or an effect resolved before every request. */
export type CredentialSource = Credentials | Effect.Effect<Credentials, AIError>

export interface DefaultChainOptions {
  readonly region: string
  /** Shared config profile passed to the AWS default chain. */
  readonly profile?: string
}

/** What the AWS chain resolves; `expiration` drives the named-profile cache. */
interface ChainIdentity {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
  readonly expiration?: Date
}

const loadIdentity = async (profile: string | undefined): Promise<ChainIdentity> => {
  const { fromNodeProviderChain } = await import("@aws-sdk/credential-providers")
  // ignoreCache re-reads shared config and SSO token files, so `aws sso login` takes effect without a restart.
  return fromNodeProviderChain({ ignoreCache: true, profile })()
}

const toCredentials = (region: string, identity: ChainIdentity): Credentials => ({
  region,
  accessKeyId: identity.accessKeyId,
  secretAccessKey: identity.secretAccessKey,
  ...(identity.sessionToken === undefined ? {} : { sessionToken: identity.sessionToken }),
})

const chainError = (error: unknown) =>
  new AIError({
    reason: new AuthenticationError({
      message: `AWS default credential chain failed: ${ProviderShared.errorText(error)}`,
      cause: error,
    }),
  })

/**
 * Resolve credentials through the AWS default provider chain: environment
 * variables, shared config and SSO caches, web identity tokens, process
 * credentials, and container or instance metadata. A fresh chain runs on every
 * request so credentials rotated on disk without an expiration (for example
 * shared-config keys rewritten by a corporate SSO tool) are always re-read;
 * the SDK's own memoization would otherwise pin them for the process lifetime.
 */
export const defaultChain = (options: DefaultChainOptions): Effect.Effect<Credentials, AIError> =>
  Effect.tryPromise({
    try: async () => toCredentials(options.region, await loadIdentity(options.profile)),
    catch: chainError,
  })

const profileIdentities = BedrockAccount.makeIdentityCache<ChainIdentity>()

/**
 * Named-profile credentials (mathpal fork). Identities that carry an expiration,
 * such as `credential_process` helpers like ada, are reused until five minutes
 * before they expire instead of spawning the helper on every request. Identities
 * without an expiration are re-read on every request, as with `defaultChain`.
 */
export const profileChain = (
  options: DefaultChainOptions & { readonly profile: string },
): Effect.Effect<Credentials, AIError> =>
  Effect.tryPromise({
    try: async () =>
      toCredentials(
        options.region,
        await profileIdentities.get(options.profile, () => loadIdentity(options.profile)),
      ),
    catch: chainError,
  })

const signRequest = (input: {
  readonly url: string
  readonly body: string
  readonly headers: Headers.Headers
  readonly credentials: Credentials
  readonly service: string
  readonly name: string
}) =>
  Effect.tryPromise({
    try: async () => {
      const signed = await new AwsV4Signer({
        url: input.url,
        method: "POST",
        headers: Object.entries(input.headers),
        body: input.body,
        region: input.credentials.region,
        accessKeyId: input.credentials.accessKeyId,
        secretAccessKey: input.credentials.secretAccessKey,
        sessionToken: input.credentials.sessionToken,
        service: input.service,
      }).sign()
      return Object.fromEntries(signed.headers.entries())
    },
    catch: (error) =>
      ProviderShared.invalidRequest(
        `${input.name} SigV4 signing failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
  })

interface SignOptions {
  readonly service?: string
  readonly name?: string
}

const signWith = (source: CredentialSource | undefined, options: SignOptions, input: AuthInput) =>
  Effect.gen(function* () {
    if (!source) {
      return yield* ProviderShared.invalidRequest(
        `${options.name ?? "Bedrock Converse"} requires either route bearer auth or AWS credentials configured on the route`,
      )
    }
    const credentials = Effect.isEffect(source) ? yield* source : source
    const headersForSigning = Headers.set(input.headers, "content-type", "application/json")
    const signed = yield* signRequest({
      url: input.url,
      body: input.body,
      headers: headersForSigning,
      credentials,
      service: options.service ?? "bedrock",
      name: options.name ?? "Bedrock Converse",
    })
    return Headers.setAll(headersForSigning, signed)
  })

/** Sign the exact JSON bytes with SigV4 using credentials configured on the route. */
export const sigV4 = (source: CredentialSource | undefined, options: SignOptions = {}) =>
  Auth.custom((input: AuthInput) => signWith(source, options, input))

/** Set by the session runner on every model request; the account pool pins sessions by it (mathpal fork). */
export const SESSION_HEADER = "x-opencode-session-id"

/**
 * SigV4 across a pool of named profiles (mathpal fork). Each session stays on
 * the profile it first drew so Bedrock's per-account prompt cache stays warm;
 * new sessions and session-less requests round-robin across the pool. The pool
 * and its cursor are process-wide, so models rebuilt from the same settings
 * keep their session assignments.
 */
export const rotatingSigV4 = (profiles: readonly string[], region: string, options: SignOptions = {}) => {
  const accounts = BedrockAccount.pool(profiles)
  return Auth.custom((input: AuthInput) =>
    Effect.gen(function* () {
      const sessionID = Option.getOrUndefined(Headers.get(input.headers, SESSION_HEADER))
      const selection = accounts.select(sessionID)
      if (selection.first) yield* Effect.logInfo("bedrock account pool", { profiles: accounts.profiles })
      if (selection.assigned)
        yield* Effect.logInfo("bedrock account", {
          "session.id": sessionID,
          profile: selection.profile,
          index: selection.index,
        })
      return yield* signWith(profileChain({ region, profile: selection.profile }), options, input)
    }),
  )
}

/** Bedrock route auth defaults to SigV4 and expects credentials from route configuration. */
export const auth = sigV4(undefined)

export const resolveRegion = (input: {
  readonly region?: string
  readonly credentials?: { readonly region: string }
}) =>
  input.region ?? input.credentials?.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1"

export interface ResolveAuthInput {
  readonly apiKey?: string
  readonly credentials?: Credentials
  readonly profile?: string
  /** Profiles to rotate across (mathpal fork). Two or more enable rotation; one behaves like `profile`. */
  readonly profiles?: readonly string[]
}

export interface ResolveAuthOptions {
  readonly service?: string
  readonly name?: string
  /** `sigv4` ignores an ambient `AWS_BEARER_TOKEN_BEDROCK`; `bearer` is validated by the caller. */
  readonly mode?: "bearer" | "sigv4"
}

/**
 * Bearer wins over SigV4 and explicit static credentials win over the default
 * chain, matching the AWS SDK's own precedence for `AWS_BEARER_TOKEN_BEDROCK`.
 * The region is applied to the SigV4 scope so it always matches the endpoint host.
 * A profile pool (mathpal fork) ranks below static credentials and above `profile`.
 */
export const resolveAuth = (input: ResolveAuthInput, region: string, options: ResolveAuthOptions = {}) => {
  const apiKey = options.mode === "sigv4" ? undefined : (input.apiKey ?? process.env.AWS_BEARER_TOKEN_BEDROCK)
  if (apiKey !== undefined) return Auth.bearer(apiKey)
  if (input.credentials !== undefined) return sigV4({ ...input.credentials, region }, options)
  const profiles = BedrockAccount.normalizeProfiles(input.profiles)
  if (profiles.length > 1) return rotatingSigV4(profiles, region, options)
  const profile = profiles[0] ?? input.profile
  return sigV4(profile === undefined ? defaultChain({ region }) : profileChain({ region, profile }), options)
}

export * as BedrockAuth from "./bedrock-auth.js"
