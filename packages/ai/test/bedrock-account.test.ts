import { describe, expect, test } from "bun:test"
import { BedrockAccount } from "../src/protocols/utils/bedrock-account.js"

describe("BedrockAccount.makePool", () => {
  test("round-robins new sessions and pins each session to its first profile", () => {
    const pool = BedrockAccount.makePool(["a", "b"])
    expect(pool.select("ses_1")).toEqual({ index: 0, profile: "a", first: true, assigned: true })
    expect(pool.select("ses_2")).toEqual({ index: 1, profile: "b", first: false, assigned: true })
    expect(pool.select("ses_3")).toEqual({ index: 0, profile: "a", first: false, assigned: true })
    expect(pool.select("ses_2")).toEqual({ index: 1, profile: "b", first: false, assigned: false })
  })

  test("rotates requests without a session id and does not pin them", () => {
    const pool = BedrockAccount.makePool(["a", "b", "c"])
    expect([undefined, undefined, undefined, undefined].map((id) => pool.select(id).profile)).toEqual([
      "a",
      "b",
      "c",
      "a",
    ])
    expect(pool.select("ses_1")).toMatchObject({ profile: "b", assigned: true })
  })

  test("forgets the least recently used session beyond capacity", () => {
    const pool = BedrockAccount.makePool(["a", "b"], 2)
    pool.select("ses_1")
    pool.select("ses_2")
    pool.select("ses_1")
    pool.select("ses_3")
    expect(pool.select("ses_1")).toMatchObject({ profile: "a", assigned: false })
    expect(pool.select("ses_2")).toMatchObject({ profile: "b", assigned: true })
  })

  test("rejects an empty pool", () => {
    expect(() => BedrockAccount.makePool([])).toThrow("Bedrock account pool requires at least one profile")
  })
})

describe("BedrockAccount.pool", () => {
  test("shares one pool per ordered profile list", () => {
    const first = BedrockAccount.pool(["pool-share-a", "pool-share-b"])
    expect(BedrockAccount.pool(["pool-share-a", "pool-share-b"])).toBe(first)
    expect(BedrockAccount.pool(["pool-share-b", "pool-share-a"])).not.toBe(first)
  })
})

describe("BedrockAccount.normalizeProfiles", () => {
  test("keeps configured order and drops blanks, duplicates, and non-strings", () => {
    expect(BedrockAccount.normalizeProfiles([" a ", "", "b", "a", 3, null])).toEqual(["a", "b"])
    expect(BedrockAccount.normalizeProfiles(undefined)).toEqual([])
    expect(BedrockAccount.normalizeProfiles("a")).toEqual([])
  })
})

describe("BedrockAccount.makeIdentityCache", () => {
  type Identity = { readonly n: number; readonly expiration?: Date }

  test("reuses an identity until five minutes before it expires", async () => {
    let now = 0
    let loads = 0
    const cache = BedrockAccount.makeIdentityCache<Identity>({ now: () => now })
    const load = async (): Promise<Identity> => ({ n: ++loads, expiration: new Date(now + 60 * 60 * 1000) })
    expect((await cache.get("p", load)).n).toBe(1)
    now = 54 * 60 * 1000
    expect((await cache.get("p", load)).n).toBe(1)
    now = 55 * 60 * 1000
    expect((await cache.get("p", load)).n).toBe(2)
  })

  test("re-reads identities without an expiration on every call", async () => {
    let loads = 0
    const cache = BedrockAccount.makeIdentityCache<Identity>()
    const load = async (): Promise<Identity> => ({ n: ++loads })
    await cache.get("p", load)
    await cache.get("p", load)
    expect(loads).toBe(2)
  })

  test("shares one in-flight load between concurrent callers", async () => {
    let loads = 0
    const cache = BedrockAccount.makeIdentityCache<Identity>()
    const load = async (): Promise<Identity> => ({ n: ++loads, expiration: new Date(Date.now() + 60 * 60 * 1000) })
    const [first, second] = await Promise.all([cache.get("p", load), cache.get("p", load)])
    expect(loads).toBe(1)
    expect(second).toBe(first)
  })

  test("retries after a failed load", async () => {
    const cache = BedrockAccount.makeIdentityCache<Identity>()
    await expect(cache.get("p", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    expect((await cache.get("p", async () => ({ n: 7 }))).n).toBe(7)
  })

  test("keeps one entry per key", async () => {
    let loads = 0
    const cache = BedrockAccount.makeIdentityCache<Identity>()
    const load = async (): Promise<Identity> => ({ n: ++loads, expiration: new Date(Date.now() + 60 * 60 * 1000) })
    await cache.get("a", load)
    await cache.get("b", load)
    await cache.get("a", load)
    expect(loads).toBe(2)
  })
})
