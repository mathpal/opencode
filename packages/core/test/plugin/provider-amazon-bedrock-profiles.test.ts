import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { AmazonBedrockPlugin } from "@opencode/core/plugin/provider/amazon-bedrock"
import { Provider } from "@opencode/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

// mathpal fork: activation for multi-account profile pools. Kept separate from upstream's test file.

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* AmazonBedrockPlugin.effect(host)
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

function withEnv<A, E, R>(vars: Record<string, string | undefined>, fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      Object.entries(vars).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    fx,
    (previous) =>
      Effect.sync(() => {
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        })
      }),
  )
}

const noAmbientAWS = {
  AWS_PROFILE: undefined,
  AWS_ACCESS_KEY_ID: undefined,
  AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
  AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
  AWS_REGION: undefined,
  AWS_DEFAULT_REGION: undefined,
}

const seedBedrock = Effect.fn(function* (settings: Provider.Settings) {
  const catalog = yield* Provider.Service
  yield* catalog.transform((catalog) => {
    catalog.update(Provider.ID.amazonBedrock, (item) => {
      item.package = "@opencode/ai/providers/amazon-bedrock"
      item.settings = settings
    })
  })
  return catalog
})

describe("AmazonBedrockPlugin profile pools", () => {
  it.effect("enables the provider when a profile pool is configured", () =>
    withEnv(noAmbientAWS, () =>
      Effect.gen(function* () {
        const catalog = yield* seedBedrock({ profiles: ["llm-profile", "llm-2-profile"] })
        yield* addPlugin()
        const result = required(yield* catalog.get(Provider.ID.amazonBedrock))
        expect(result.activation).toBe("enabled")
        expect(result.settings).toEqual({ profiles: ["llm-profile", "llm-2-profile"], region: "us-east-1" })
      }),
    ),
  )

  it.effect("leaves activation on auto for an empty or non-string pool", () =>
    withEnv(noAmbientAWS, () =>
      Effect.gen(function* () {
        const catalog = yield* seedBedrock({ profiles: ["", " ", 3] })
        yield* addPlugin()
        expect(required(yield* catalog.get(Provider.ID.amazonBedrock)).activation).toBe("auto")
      }),
    ),
  )
})
