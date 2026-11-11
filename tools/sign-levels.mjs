#!/usr/bin/env node
// Signs levels/index.json for the game's other copies. Run by the game's operator after tools/ingest.mjs add.
//   node tools/sign-levels.mjs <ECDSA P-256 private key, PKCS#8 PEM file>
// It writes each listed level file's SHA-256 into its entry, rewrites levels/index.json, and writes
// levels/index.sig: an ECDSA P-256 / SHA-256 signature (r||s, base64) over the exact bytes of index.json. A copy of
// the game on another address (index.html, sharedLevels) reads both through the Swarmcaster relay and runs a level
// only when the signature verifies with LEVEL_KEY and the level file matches its SHA-256.
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function signLevels(root, privateKeyPem) {
  const file = join(root, "levels", "index.json");
  const index = JSON.parse(readFileSync(file, "utf8"));
  for (const entry of index.levels) {
    if (!/^[a-z0-9-]{3,48}$/.test(entry.id || "")) throw new Error(`bad level id ${JSON.stringify(entry.id)}`);
    entry.sha256 = createHash("sha256").update(readFileSync(join(root, "levels", `${entry.id}.js`))).digest("hex");
  }
  const bytes = Buffer.from(JSON.stringify(index, null, 2) + "\n");
  const signature = sign("sha256", bytes, { key: createPrivateKey(privateKeyPem), dsaEncoding: "ieee-p1363" });
  writeFileSync(file, bytes);
  writeFileSync(join(root, "levels", "index.sig"), signature.toString("base64") + "\n");
  return { levels: index.levels.length, signature: signature.toString("base64") };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const keyFile = process.argv[2];
  if (!keyFile) { console.error("usage: node tools/sign-levels.mjs <private key PEM file>"); process.exit(2); }
  const r = signLevels(ROOT, readFileSync(keyFile, "utf8"));
  console.log(`signed levels/index.json: ${r.levels} level(s)`);
}
