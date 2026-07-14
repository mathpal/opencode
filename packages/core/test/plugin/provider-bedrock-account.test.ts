import { expect, test } from "bun:test"
import {
  bedrockProfiles,
  makeAccountRotator,
  selectBedrockAccount,
  withBedrockAccount,
} from "@opencode-ai/core/plugin/provider/bedrock-account"

test("filters configured Bedrock profiles", () => {
  expect(bedrockProfiles({ profiles: ["first", "", 42, "second"] })).toEqual(["first", "second"])
  expect(bedrockProfiles(undefined)).toEqual([])
})

test("keeps a session on one account while rotating new sessions", () => {
  const profiles = ["first", "second"]
  const first = selectBedrockAccount("amazon-bedrock", "bedrock-account-test-a", profiles)
  const second = selectBedrockAccount("amazon-bedrock", "bedrock-account-test-b", profiles)
  const repeated = selectBedrockAccount("amazon-bedrock", "bedrock-account-test-a", profiles)

  expect(first.profile).not.toBe(second.profile)
  expect(repeated).toEqual({ ...first, newlyAssigned: false })
})

test("uses the request-scoped account for credential resolution", async () => {
  const credentials = [{ accessKeyId: "first" }, { accessKeyId: "second" }]
  const provider = makeAccountRotator(credentials.map((item) => async () => item))

  expect(await withBedrockAccount(1, provider)).toEqual(credentials[1])
  expect(await withBedrockAccount(0, provider)).toEqual(credentials[0])
})

test("rotates credential providers outside request context", async () => {
  const provider = makeAccountRotator([async () => "first", async () => "second"])
  const first = await provider()
  const second = await provider()

  expect(first).not.toBe(second)
})

test("keeps session assignments separate across Bedrock providers", () => {
  const primaryProfiles = ["primary-a", "primary-b", "primary-c"]
  const eastProfiles = ["east-a", "east-b"]
  let sessionID: string | undefined

  for (let index = 0; index < primaryProfiles.length; index++) {
    const candidate = `bedrock-cross-provider-${index}`
    if (selectBedrockAccount("amazon-bedrock", candidate, primaryProfiles).index === 2) sessionID = candidate
  }

  expect(sessionID).toBeDefined()
  const east = selectBedrockAccount("amazon-bedrock-east", sessionID, eastProfiles)
  expect(east.index).toBeLessThan(eastProfiles.length)
  expect(east.profile).toBeDefined()
})

test("falls back safely when the request account index exceeds the credential pool", async () => {
  const provider = makeAccountRotator([async () => "first", async () => "second"])
  const credential = await withBedrockAccount(2, provider)

  expect(["first", "second"]).toContain(credential)
})
