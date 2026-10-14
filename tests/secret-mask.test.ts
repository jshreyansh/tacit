import test from "node:test";
import assert from "node:assert/strict";

import { maskSecrets } from "../shared/secret-mask";

test("one-time codes are masked when a word says they are one", () => {
  assert.equal(maskSecrets("the OTP is 482913, log in"), "the OTP is [masked:otp], log in");
  assert.equal(maskSecrets("Verification code: 123 456"), "Verification code: [masked:otp]");
  assert.equal(maskSecrets("your 2FA code is 4829-13"), "your 2FA code is [masked:otp]");
  // Numbers without such a word are left alone: line numbers, years, ports.
  assert.equal(maskSecrets("see line 4829 of the 2026 log on port 8080"), "see line 4829 of the 2026 log on port 8080");
});

test("passwords are masked after password:, = or is", () => {
  assert.equal(maskSecrets("password: hunter2!"), "password: [masked:password]");
  assert.equal(maskSecrets("login with pwd=s3cr3t and go"), "login with pwd=[masked:password] and go");
  assert.equal(maskSecrets("my password is Tr0ub4dor&3"), "my password is [masked:password]");
  assert.equal(maskSecrets("reset the password for the admin page"), "reset the password for the admin page");
});

test("keys, tokens and private keys are masked", () => {
  assert.equal(maskSecrets("export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuv"), "export ANTHROPIC_API_KEY=[masked:key]");
  assert.equal(maskSecrets("token ghp_" + "a".repeat(36)), "token [masked:key]");
  assert.equal(maskSecrets("AKIAIOSFODNN7EXAMPLE"), "[masked:key]");
  assert.equal(maskSecrets("Authorization: Bearer abc.def-123"), "Authorization: Bearer [masked:token]");
  assert.equal(maskSecrets("jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4"), "jwt [masked:token]");
  assert.equal(
    maskSecrets("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----"),
    "[masked:private_key]",
  );
});

test("a masked line of JSON is still JSON", () => {
  const line = JSON.stringify({ type: "user", message: { content: 'use password: "x" or password: abc\\"def and OTP 123456' } });
  const masked = maskSecrets(line);
  assert.doesNotThrow(() => JSON.parse(masked));
  assert.ok(!masked.includes("123456"));
  assert.equal(maskSecrets("nothing secret here"), "nothing secret here");
});
