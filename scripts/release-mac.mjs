#!/usr/bin/env node
/**
 * Builds a macOS release of Tacit, signed and notarized, checks it the way a
 * stranger's Mac and the updater will, and (with --publish) publishes it.
 *
 *   pnpm release:mac             build, notarize, verify; publishes nothing
 *   pnpm release:mac --publish   then a GitHub release with every file, made
 *                                public only once all of them are uploaded
 *
 * Releases come from here, not CI: CI has no Developer ID certificate, and an
 * unsigned Mac build is refused by Gatekeeper. See docs/releasing.md.
 *
 * Notarization uses a notarytool keychain profile (APPLE_KEYCHAIN_PROFILE,
 * default "tacit-notary"), created once with `xcrun notarytool
 * store-credentials`, so no Apple password is ever in the environment.
 * electron-builder skips notarizing without a word when it finds no
 * credentials, so nothing here trusts the build: every app, zip and disk
 * image is checked for a stapled ticket before anything is published.
 *
 * Every step stops the release on failure. Nothing is retried or skipped.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = path.join(ROOT, "out");
const publish = process.argv.includes("--publish");
const profile = process.env.APPLE_KEYCHAIN_PROFILE || "tacit-notary";
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const tag = `v${version}`;

function step(title) {
  console.log(`\n▸ ${title}`);
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

/** Runs a command, output shown; stops the release if it fails. */
function run(file, args, options = {}) {
  const result = spawnSync(file, args, { cwd: ROOT, stdio: "inherit", ...options });
  if (result.status !== 0) fail(`${file} ${args.join(" ")} failed (exit ${result.status ?? result.signal})`);
}

/** Runs a command and returns its output; null if it fails. */
function read(file, args, options = {}) {
  const result = spawnSync(file, args, { cwd: ROOT, encoding: "utf8", ...options });
  return result.status === 0 ? `${result.stdout}${result.stderr}` : null;
}

// ── Before building ─────────────────────────────────────────────────────────

step(`Checking Tacit ${version} can be released`);
if (process.platform !== "darwin") fail("Mac releases are built on a Mac.");

const branch = read("git", ["rev-parse", "--abbrev-ref", "HEAD"])?.trim();
if (branch !== "main") fail(`On ${branch}; releases come from main.`);
if (read("git", ["status", "--porcelain"])?.trim()) fail("The working tree has changes; commit or stash them first.");
run("git", ["fetch", "--quiet", "origin", "main", "--tags"]);
const head = read("git", ["rev-parse", "HEAD"]).trim();
if (head !== read("git", ["rev-parse", "origin/main"])?.trim()) fail("main isn't the same as origin/main; push or pull first.");
if (read("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]) !== null) fail(`${tag} is already tagged; bump the version in package.json.`);

const changelog = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
const notes = changelog.match(new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, "m"))?.[1]?.trim();
if (!notes) fail(`CHANGELOG.md has no entry for ${version}.`);

if (!/Developer ID Application/.test(read("security", ["find-identity", "-v", "-p", "codesigning"]) ?? "")) {
  fail("No Developer ID Application certificate in the keychain (docs/releasing.md, step 1).");
}
if (read("xcrun", ["notarytool", "history", "--keychain-profile", profile]) === null) {
  fail(
    `No notarytool profile "${profile}". Create it once (it asks for an app-specific password):\n` +
      `  xcrun notarytool store-credentials ${profile} --apple-id <your Apple ID> --team-id <your Team ID>`,
  );
}
if (publish) {
  if (read("gh", ["auth", "status"]) === null) fail("gh isn't signed in to GitHub (gh auth login).");
  if (read("gh", ["release", "view", tag]) !== null) fail(`A GitHub release ${tag} already exists.`);
}
console.log(
  process.env.VITE_SUPABASE_URL && process.env.VITE_SUPABASE_ANON_KEY
    ? "  Sign-in and usage sync: on (VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set)."
    : "  Sign-in and usage sync: off, as in 0.39.17 (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set).",
);

// ── Build, sign, notarize ───────────────────────────────────────────────────

step("Building");
fs.rmSync(OUT, { recursive: true, force: true });
run("pnpm", ["build"]);

step(`Packaging, signing and notarizing with the "${profile}" profile (notarizing takes a few minutes)`);
// Only the keychain profile: electron-builder prefers an Apple ID or API key
// when it finds one, and this should be the same credential every time.
const env = { ...process.env, APPLE_KEYCHAIN_PROFILE: profile };
for (const name of ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) delete env[name];
run("pnpm", ["exec", "electron-builder", "--mac", "--publish", "never"], { env });

step("Optimizing the zips for delta updates");
const zips = fs.readdirSync(OUT).filter((name) => name.endsWith(".zip"));
if (zips.length !== 2) fail(`Expected an arm64 and an x64 zip; found ${zips.join(", ") || "none"}.`);
for (const zip of zips) {
  const file = path.join(OUT, zip);
  run("pnpm", ["exec", "rezip-electron", "optimize", file, "-o", `${file}.tmp`]);
  fs.renameSync(`${file}.tmp`, file);
  run("pnpm", ["exec", "better-blockmap", "--input", file, "--output", `${file}.blockmap`, "--compression", "gzip", "--detect-zip-boundary"]);
}
run("node", ["scripts/update-mac-yml.cjs"]);

// ── Verify what users will get ──────────────────────────────────────────────

step("Verifying");

function verifyApp(app, where) {
  const plist = path.join(app, "Contents", "Info.plist");
  const appVersion = read("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist])?.trim();
  if (appVersion !== version) fail(`${where}: the app says ${appVersion}, not ${version}.`);
  if (read("codesign", ["--verify", "--deep", "--strict", app]) === null) fail(`${where}: the signature doesn't verify.`);
  const info = read("codesign", ["-dv", "--verbose=2", app]) ?? "";
  if (!/Authority=Developer ID Application/.test(info)) fail(`${where}: not signed with a Developer ID.`);
  if (!/flags=0x10000\(runtime\)/.test(info)) fail(`${where}: the hardened runtime is off.`);
  if (read("xcrun", ["stapler", "validate", app]) === null) fail(`${where}: no notarization ticket stapled.`);
  if (!/source=Notarized Developer ID/.test(read("spctl", ["-a", "-vv", "-t", "exec", app]) ?? "")) {
    fail(`${where}: Gatekeeper doesn't accept it as notarized.`);
  }
  console.log(`  ✓ ${where}: ${version}, Developer ID, hardened runtime, stapled, accepted by Gatekeeper`);
}

for (const dir of fs.readdirSync(OUT).filter((name) => name.startsWith("mac"))) {
  verifyApp(path.join(OUT, dir, "Tacit.app"), `out/${dir}/Tacit.app`);
}

// The updater installs from the zips, and people from the disk images: check
// the app inside each, not only the one electron-builder left in out/.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-release-"));
try {
  for (const zip of zips) {
    const dest = path.join(scratch, zip);
    run("ditto", ["-xk", path.join(OUT, zip), dest]);
    verifyApp(path.join(dest, "Tacit.app"), zip);
  }
  for (const dmg of fs.readdirSync(OUT).filter((name) => name.endsWith(".dmg"))) {
    const mount = path.join(scratch, `mnt-${dmg}`);
    fs.mkdirSync(mount);
    run("hdiutil", ["attach", "-nobrowse", "-readonly", "-quiet", "-mountpoint", mount, path.join(OUT, dmg)]);
    try {
      verifyApp(path.join(mount, "Tacit.app"), dmg);
    } finally {
      run("hdiutil", ["detach", "-quiet", mount]);
    }
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

// What the updater reads: the version, and a hash and size for each zip that
// match the files exactly (a mismatch is a failed update on every Mac).
const yml = fs.readFileSync(path.join(OUT, "latest-mac.yml"), "utf8");
if (!new RegExp(`^version: ${version.replace(/\./g, "\\.")}$`, "m").test(yml)) fail(`latest-mac.yml isn't for ${version}.`);
for (const zip of zips) {
  const bytes = fs.readFileSync(path.join(OUT, zip));
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  const entry = yml.match(new RegExp(`url: ${zip.replace(/\./g, "\\.")}\\s+sha512: (\\S+)\\s+size: (\\d+)`));
  if (!entry) fail(`latest-mac.yml doesn't list ${zip}.`);
  if (entry[1] !== sha512 || Number(entry[2]) !== bytes.length) fail(`latest-mac.yml's hash or size for ${zip} doesn't match the file.`);
}
console.log(`  ✓ latest-mac.yml: ${version}, and both zips' hashes and sizes match`);

const files = fs
  .readdirSync(OUT)
  .filter((name) => /\.(dmg|zip|blockmap)$/.test(name) || name === "latest-mac.yml")
  .sort();

if (!publish) {
  console.log(`\n✓ Tacit ${version} is built, notarized and verified. Nothing was published.`);
  console.log(`  Files in out/: ${files.join(", ")}`);
  console.log("  To publish it: pnpm release:mac --publish");
  process.exit(0);
}

// ── Publish ─────────────────────────────────────────────────────────────────

step(`Publishing ${tag}`);
// A draft first, with every file, then public: the updater reads the latest
// release's latest-mac.yml, which must never point at a zip still uploading.
const notesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tacit-notes-")), "notes.md");
fs.writeFileSync(notesFile, `${notes}\n`);
run("gh", ["release", "create", tag, "--draft", "--target", head, "--title", `Tacit ${version}`, "--notes-file", notesFile, ...files.map((name) => path.join(OUT, name))]);
run("gh", ["release", "edit", tag, "--draft=false", "--latest"]);
const url = read("gh", ["release", "view", tag, "--json", "url", "-q", ".url"])?.trim();
console.log(`\n✓ Tacit ${version} is published: ${url}`);
console.log("  Installed copies find it the next time they check for updates.");
