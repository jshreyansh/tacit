import test from "node:test";
import assert from "node:assert/strict";
import { isEmbeddedAuthBlockedUrl, isSafeExternalUrl } from "../electron/external-url";

test("isSafeExternalUrl only allows http and https URLs", () => {
  assert.equal(isSafeExternalUrl("https://example.com/path"), true);
  assert.equal(isSafeExternalUrl("http://localhost:3000"), true);
  assert.equal(isSafeExternalUrl("file:///Users/test/.ssh/id_rsa"), false);
  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
  assert.equal(isSafeExternalUrl("x-apple.systempreferences:Privacy_Accessibility"), false);
  assert.equal(isSafeExternalUrl("not a url"), false);
});

test("Google's sign-in pages leave a node; its silent session checks stay (SHR-132)", () => {
  for (const url of [
    "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com",
    "https://accounts.google.com/v3/signin/accountchooser?continue=https%3A%2F%2Fmyaccount.google.com",
    "https://accounts.google.com/v3/signin/rejected",
    "https://accounts.google.com/signin/v2/identifier",
    "https://accounts.google.com/InteractiveLogin?continue=x",
    "https://accounts.google.com/AddSession",
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    "https://appleid.apple.com/auth/authorize",
  ]) assert.equal(isEmbeddedAuthBlockedUrl(url), true, url);

  for (const url of [
    "https://accounts.google.com/ServiceLogin?passive=1209600&continue=https%3A%2F%2Fmyaccount.google.com",
    "https://accounts.google.com/CheckCookie?continue=https%3A%2F%2Fmail.google.com",
    "https://accounts.google.com/accounts/SetSID?ssdc=1",
    "https://accounts.google.com/RotateCookiesPage",
    "https://accounts.youtube.com/accounts/SetSID",
    "https://accounts.google.com/signinx", // not a sign-in page, only a similar name
    "https://mail.google.com/mail/u/0/",
    "not a url",
  ]) assert.equal(isEmbeddedAuthBlockedUrl(url), false, url);
});
