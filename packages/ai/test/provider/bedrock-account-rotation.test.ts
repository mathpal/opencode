import { afterAll, describe, expect } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/http"
import { LLM, type LanguageModel } from "../../src/index.js"
import { AmazonBedrock, AmazonBedrockMantle } from "../../src/providers.js"
import { compileRequest, LLMClient } from "../../src/route/client.js"
import { it } from "../lib/effect.js"
import { withProcessEnv } from "../lib/env.js"
import { dynamicResponse } from "../lib/http.js"

// mathpal fork: multi-account Bedrock rotation. Kept in its own file so upstream test edits never conflict.

const root = mkdtempSync(path.join(tmpdir(), "bedrock-rotation-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// Unique names keep the process-wide pools and credential cache independent per test.
const names = (count: number) => Array.from({ length: count }, (_, index) => `rotation-${index}-${randomUUID()}`)

// Clears every input the AWS default chain reads so tests never reach the developer's profiles or instance metadata.
const noAmbientAWS = {
  AWS_ACCESS_KEY_ID: undefined,
  AWS_SECRET_ACCESS_KEY: undefined,
  AWS_SESSION_TOKEN: undefined,
  AWS_BEARER_TOKEN_BEDROCK: undefined,
  AWS_PROFILE: undefined,
  AWS_REGION: undefined,
  AWS_DEFAULT_REGION: undefined,
  AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
  AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
  AWS_EC2_METADATA_DISABLED: "true",
}

// Shared credentials file with one static key pair per profile: profile i signs as AKIAPOOL<i>EXAMPLE.
const poolFiles = (profiles: readonly string[]) => {
  const dir = mkdtempSync(path.join(root, "aws-"))
  const credentials = path.join(dir, "credentials")
  const config = path.join(dir, "config")
  writeFileSync(
    credentials,
    profiles
      .map(
        (name, index) =>
          `[${name}]\naws_access_key_id = AKIAPOOL${index}EXAMPLE\naws_secret_access_key = pool-secret-${index}\n`,
      )
      .join("\n"),
  )
  writeFileSync(config, "")
  return { AWS_SHARED_CREDENTIALS_FILE: credentials, AWS_CONFIG_FILE: config }
}

// A credential_process profile that counts its invocations, like ada behind ~/.aws/config.
const processProfile = (expiresInMs: number) => {
  const [name] = names(1)
  const dir = mkdtempSync(path.join(root, "process-"))
  const counter = path.join(dir, "count")
  const script = path.join(dir, "creds.sh")
  const config = path.join(dir, "config")
  const credentials = path.join(dir, "credentials")
  writeFileSync(counter, "0")
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `n=$(cat '${counter}')`,
      `echo $((n + 1)) > '${counter}'`,
      `printf '%s\\n' '{"Version":1,"AccessKeyId":"AKIAPROCESSEXAMPLE","SecretAccessKey":"process-secret","SessionToken":"process-token","Expiration":"${new Date(Date.now() + expiresInMs).toISOString()}"}'`,
      "",
    ].join("\n"),
  )
  writeFileSync(config, `[profile ${name}]\ncredential_process = /bin/sh ${script}\n`)
  writeFileSync(credentials, "")
  return {
    name,
    env: { AWS_CONFIG_FILE: config, AWS_SHARED_CREDENTIALS_FILE: credentials },
    loads: () => Number(readFileSync(counter, "utf8").trim()),
  }
}

const accessKey = (authorization: string | null | undefined) =>
  authorization?.match(/Credential=([A-Z0-9]+)\//)?.[1]

// Sends one request through the route and returns the SigV4 access key it was signed with.
const send = (model: LanguageModel, sessionID?: string, contentType = "application/vnd.amazon.eventstream") =>
  Effect.gen(function* () {
    const seen: Array<string | null> = []
    yield* LLMClient.generate(
      LLM.request({
        model,
        prompt: "Hi",
        ...(sessionID === undefined ? {} : { http: { headers: { "x-opencode-session-id": sessionID } } }),
      }),
    ).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const request = yield* HttpClientRequest.toWeb(input.request)
            seen.push(request.headers.get("authorization"))
            return input.respond("", { headers: { "content-type": contentType } })
          }),
        ),
      ),
      Effect.exit,
    )
    return accessKey(seen[0])
  })

const converse = (settings: AmazonBedrock.Settings) =>
  AmazonBedrock.model("anthropic.claude-sonnet-4-5-20250929-v1:0", {
    baseURL: "https://bedrock-runtime.test",
    region: "us-west-2",
    ...settings,
  })

describe("Bedrock account rotation (Converse)", () => {
  it.effect("pins each session to one profile and round-robins new sessions across the pool", () => {
    const profiles = names(2)
    return Effect.gen(function* () {
      const model = converse({ profiles })
      expect(yield* send(model, "ses_a")).toBe("AKIAPOOL0EXAMPLE")
      expect(yield* send(model, "ses_b")).toBe("AKIAPOOL1EXAMPLE")
      expect(yield* send(model, "ses_a")).toBe("AKIAPOOL0EXAMPLE")
      expect(yield* send(model, "ses_c")).toBe("AKIAPOOL0EXAMPLE")
      // Models rebuilt from the same settings share the process-wide pool, so stickiness survives.
      expect(yield* send(converse({ profiles }), "ses_b")).toBe("AKIAPOOL1EXAMPLE")
    }).pipe(withProcessEnv({ ...noAmbientAWS, ...poolFiles(profiles) }))
  })

  it.effect("rotates requests without a session id across the pool", () => {
    const profiles = names(2)
    return Effect.gen(function* () {
      const model = converse({ profiles })
      expect(yield* send(model)).toBe("AKIAPOOL0EXAMPLE")
      expect(yield* send(model)).toBe("AKIAPOOL1EXAMPLE")
    }).pipe(withProcessEnv({ ...noAmbientAWS, ...poolFiles(profiles) }))
  })

  it.effect("treats a one-element pool like profile", () => {
    const profiles = names(1)
    return Effect.gen(function* () {
      const model = converse({ profiles })
      expect(yield* send(model, "ses_a")).toBe("AKIAPOOL0EXAMPLE")
      expect(yield* send(model, "ses_b")).toBe("AKIAPOOL0EXAMPLE")
    }).pipe(withProcessEnv({ ...noAmbientAWS, ...poolFiles(profiles) }))
  })

  it.effect("lets static credentials win over a pool", () => {
    const profiles = names(2)
    return Effect.gen(function* () {
      const model = converse({
        profiles,
        credentials: {
          region: "us-west-2",
          accessKeyId: "AKIAIOSFODNN7EXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        },
      })
      expect(yield* send(model, "ses_a")).toBe("AKIAIOSFODNN7EXAMPLE")
    }).pipe(withProcessEnv({ ...noAmbientAWS, ...poolFiles(profiles) }))
  })

  it.effect("reuses credential_process identities until shortly before they expire", () => {
    const helper = processProfile(60 * 60 * 1000)
    return Effect.gen(function* () {
      const model = converse({ profile: helper.name })
      expect(yield* send(model, "ses_a")).toBe("AKIAPROCESSEXAMPLE")
      expect(yield* send(model, "ses_b")).toBe("AKIAPROCESSEXAMPLE")
      expect(helper.loads()).toBe(1)
    }).pipe(withProcessEnv({ ...noAmbientAWS, ...helper.env }))
  })

  it.effect("re-runs credential_process when the identity expires within the refresh margin", () => {
    const helper = processProfile(2 * 60 * 1000)
    return Effect.gen(function* () {
      const model = converse({ profile: helper.name })
      yield* send(model, "ses_a")
      yield* send(model, "ses_b")
      expect(helper.loads()).toBe(2)
    }).pipe(withProcessEnv({ ...noAmbientAWS, ...helper.env }))
  })
})

describe("Bedrock account rotation (Mantle)", () => {
  it.effect("rotates Mantle Responses requests across the pool and keeps profiles out of the body", () => {
    const profiles = names(2)
    return Effect.gen(function* () {
      const model = AmazonBedrockMantle.responsesModel("openai.gpt-5.5", {
        region: "us-east-2",
        baseURL: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
        profiles,
      })
      const prepared = yield* compileRequest(LLM.request({ model, prompt: "Hi" }))
      expect(prepared.body).not.toHaveProperty("profiles")
      // compileRequest consumes the first pool selection, so the indices are offset by 1
      expect(yield* send(model, "ses_a", "text/event-stream")).toBe("AKIAPOOL1EXAMPLE")
      expect(yield* send(model, "ses_b", "text/event-stream")).toBe("AKIAPOOL0EXAMPLE")
      expect(yield* send(model, "ses_a", "text/event-stream")).toBe("AKIAPOOL1EXAMPLE")
    }).pipe(withProcessEnv({ ...noAmbientAWS, ...poolFiles(profiles) }))
  })
})
