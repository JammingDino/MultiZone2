// The error reader in `src/lib/errors.ts`.
//
// What it must never do is show a user "io error: … (os error 2)" or a provider's
// JSON as the headline, and what it must never do the other way is swallow a
// message the backend already wrote in plain English. Both directions are here.

import test from "node:test";
import assert from "node:assert/strict";
import { friendlyError, rawError, errorText } from "../src/lib/errors.ts";

const headline = (e) => friendlyError(e).headline;

test("backend AppError strings get a plain headline, raw kept", () => {
  const raw = "io error: The system cannot find the file specified. (os error 2)";
  const f = friendlyError(raw);
  assert.equal(f.headline, "The file or folder couldn't be found");
  assert.equal(f.raw, raw);
  assert.equal(headline("io error: Access is denied. (os error 5)"), "Windows denied access");
  assert.equal(headline("io error: The process cannot access the file because it is being used by another process. (os error 32)"), "The file is open in another program");
  assert.equal(
    headline("database error: error returned from database: (code: 2067) UNIQUE constraint failed: providers.name"),
    "Something with that name already exists",
  );
  assert.equal(headline("not found: chat 3f2a9c1e-0000-4000-8000-000000000000"), "That chat no longer exists");
  assert.equal(headline("json error: expected value at line 1 column 1"), "The data wasn't in the expected format");
});

test("provider errors", () => {
  assert.equal(headline('provider error: 401 {"error":{"code":"invalid_api_key"}}'), "The provider rejected your API key");
  assert.equal(headline("provider error: 429 Too Many Requests"), "Rate limited or out of quota");
  assert.equal(friendlyError("http error: error sending request for url (http://localhost:11434/v1/models)").action, "retry");
  assert.equal(headline("provider error: 503 overloaded"), "The server had an error");
});

test("plain messages pass through, minus the category prefix", () => {
  assert.equal(
    headline("invalid input: no speech provider configured — pick one in Settings → Voice"),
    "No speech provider configured — pick one in Settings → Voice",
  );
  assert.equal(headline(new Error("a catalog URL must start with https://")), "A catalog URL must start with https://");
});

test("jargon falls back, and the fallback is the caller's to choose", () => {
  assert.equal(headline("MCP child has no stdout"), "Something went wrong");
  const f = friendlyError('provider error: {"weird":"shape"}', { headline: "The response failed", hint: "x", action: "retry" });
  assert.equal(f.headline, "The response failed");
  assert.equal(f.action, "retry");
});

test("rawError reads every shape a catch sees", () => {
  assert.equal(rawError("plain"), "plain");
  assert.equal(rawError(new Error("boom")), "boom");
  assert.equal(rawError("Error: boom"), "boom");
  assert.equal(rawError({ message: "obj" }), "obj");
  assert.equal(rawError(undefined), "undefined");
  assert.equal(errorText("io error: Access is denied. (os error 5)").startsWith("Windows denied access. "), true);
});
