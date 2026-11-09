import { expect, test } from "bun:test"
import path from "node:path"
import { isAllowedEmail, restore } from "../src/sigma-auth"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"

test("only accepts sigmalabs.co.uk email addresses", () => {
  expect(isAllowedEmail("ada@sigmalabs.co.uk")).toBe(true)
  expect(isAllowedEmail("Ada@SigmaLabs.co.uk")).toBe(true)
  expect(isAllowedEmail("ada@gmail.com")).toBe(false)
  expect(isAllowedEmail("ada@evil.sigmalabs.co.uk")).toBe(false)
  expect(isAllowedEmail("ada@sigmalabs.co.uk.evil.com")).toBe(false)
  expect(isAllowedEmail("ada@sigmalabs.co.uk@gmail.com")).toBe(false)
  expect(isAllowedEmail("@sigmalabs.co.uk")).toBe(false)
})

test("restore signs nobody in without a stored session", async () => {
  await using root = await tmpdir()
  expect(
    await restore({ domain: "example.invalid", clientID: "client" }, path.join(root.path, "sigma-auth.json")),
  ).toBeUndefined()
})

test("blocks the app until sign-in succeeds", async () => {
  await using setup = await createAppFixture({ signIn: { domain: "sigmabot-test.invalid", clientID: "client" } })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Sign in to SigmaBot"))
  expect(setup.captureCharFrame()).not.toContain("commands")
})

test("does not gate the app without sign-in settings", async () => {
  await using setup = await createAppFixture()
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  expect(setup.captureCharFrame()).not.toContain("Sign in to SigmaBot")
})
