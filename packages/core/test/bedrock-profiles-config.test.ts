import { describe, expect, test } from "bun:test"
import { AISDKNative } from "@opencode/core/aisdk-native"
import { ConfigProviderOptionsV1 } from "@opencode/core/v1/config/provider-options"

// mathpal fork: pins that a v1 `options.profiles` array reaches the native Bedrock packages.

function map(packageName: string, settings: Readonly<Record<string, unknown>>, modelID: string) {
  const target: {
    package?: string
    settings?: Record<string, unknown>
    headers?: Record<string, string>
    body?: Record<string, unknown>
  } = {
    package: `aisdk:${packageName}`,
    settings: { ...settings },
  }
  AISDKNative.rewrite(target, { specifier: target.package, providerID: "amazon-bedrock", modelID })
  return target
}

describe("Bedrock profile pools in config", () => {
  test("v1 provider options keep the profiles array as a package setting", () => {
    expect(
      ConfigProviderOptionsV1.provider({ profiles: ["llm-profile", "llm-2-profile"], region: "us-west-2" }),
    ).toEqual({
      settings: { profiles: ["llm-profile", "llm-2-profile"], region: "us-west-2" },
      headers: undefined,
      body: undefined,
    })
  })

  test("native rewrite forwards profiles to the Converse and Mantle packages", () => {
    expect(
      map("@ai-sdk/amazon-bedrock", { profiles: ["a", "b"], region: "us-west-2" }, "global.anthropic.claude-opus-5-5"),
    ).toMatchObject({
      package: "@opencode/ai/providers/amazon-bedrock",
      settings: { profiles: ["a", "b"], region: "us-west-2" },
    })
    expect(map("@ai-sdk/amazon-bedrock/mantle", { profile: "llm-profile", region: "us-east-2" }, "openai.gpt-5.5")).toMatchObject({
      package: "@opencode/ai/providers/amazon-bedrock/mantle/responses",
      settings: { profile: "llm-profile", region: "us-east-2" },
    })
  })
})
