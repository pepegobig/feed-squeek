// node --test tools/sign-levels.test.mjs
// A signed level list verifies the way index.html checks it (WebCrypto ECDSA P-256), and a changed list or a changed
// level file does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signLevels } from "./sign-levels.mjs";

const { subtle } = webcrypto;
const hexOf = (buf) => Buffer.from(buf).toString("hex");

async function pageAccepts(root, publicKeyB64) {
  const raw = readFileSync(join(root, "levels", "index.json"));
  const sig = Buffer.from(readFileSync(join(root, "levels", "index.sig"), "utf8").trim(), "base64");
  const key = await subtle.importKey("spki", Buffer.from(publicKeyB64, "base64"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, raw))) return null;
  const list = JSON.parse(raw).levels;
  const ok = [];
  for (const d of list) {
    const file = readFileSync(join(root, "levels", `${d.id}.js`));
    if (hexOf(await subtle.digest("SHA-256", file)) === d.sha256) ok.push(d.id);
  }
  return ok;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "sign-levels-"));
  mkdirSync(join(root, "levels"));
  writeFileSync(join(root, "levels", "index.json"), JSON.stringify({ levels: [{ id: "one-level", name: "One" }, { id: "two-level", name: "Two" }] }));
  writeFileSync(join(root, "levels", "one-level.js"), "FeedSqueek.level({ id: \"one-level\" });");
  writeFileSync(join(root, "levels", "two-level.js"), "FeedSqueek.level({ id: \"two-level\" });");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  signLevels(root, privateKey.export({ type: "pkcs8", format: "pem" }));
  return { root, pub: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}

test("a signed list and its level files are accepted", async () => {
  const { root, pub } = setup();
  assert.deepEqual(await pageAccepts(root, pub), ["one-level", "two-level"]);
});

test("a changed list is refused", async () => {
  const { root, pub } = setup();
  const file = join(root, "levels", "index.json");
  writeFileSync(file, readFileSync(file, "utf8").replace('"Two"', '"Evil"'));
  assert.equal(await pageAccepts(root, pub), null);
});

test("a changed level file is dropped", async () => {
  const { root, pub } = setup();
  writeFileSync(join(root, "levels", "two-level.js"), "FeedSqueek.level({ id: \"two-level\", evil: 1 });");
  assert.deepEqual(await pageAccepts(root, pub), ["one-level"]);
});

test("another key's signature is refused", async () => {
  const { root } = setup();
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
  assert.equal(await pageAccepts(root, other), null);
});
