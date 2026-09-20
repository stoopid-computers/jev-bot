import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  checkPublishedVersions,
  ensureReleaseAssets,
  fileManifest,
  npmTag,
  registryJson,
  verifyJsrVersion,
  verifyNpmArchiveMetadata,
  verifyNpmVersion,
} from "../scripts/release-lib.mjs";

const packageName = "@compootor/jev-bot";

function metadata(version = "0.1.0") {
  return [
    { name: packageName, version, publishConfig: { access: "public" } },
    {
      name: packageName,
      version,
      packages: {
        "": { name: packageName, version },
        "node_modules/example": { version: "4.0.0" },
      },
    },
    { name: packageName, version, exports: { ".": "./dist/index.js" } },
  ];
}

async function releaseFixture(
  t: TestContext,
  version = "0.1.0",
  branch = "release/0.1",
) {
  const directory = await mkdtemp(join(tmpdir(), "jev-bot-release-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (name.startsWith("GITHUB_") || name.startsWith("GIT_")) delete env[name];
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: directory,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const names = ["package.json", "package-lock.json", "jsr.json"];
  const writeMetadata = async (values: ReturnType<typeof metadata>) => {
    for (const [index, name] of names.entries())
      await writeFile(join(directory, name), JSON.stringify(values[index]));
  };
  await mkdir(join(directory, "scripts"));
  for (const name of ["release.mjs", "release-lib.mjs"])
    await cp(
      new URL(`../scripts/${name}`, import.meta.url),
      join(directory, "scripts", name),
    );
  await writeMetadata(metadata(version));
  git("init", "-b", branch);
  git("add", ".");
  git(
    "-c",
    "user.name=Release test",
    "-c",
    "user.email=release@example.test",
    "commit",
    "-m",
    "fixture",
  );
  return {
    git,
    writeMetadata,
    readMetadata: () =>
      Promise.all(
        names.map(async (name) =>
          JSON.parse(await readFile(join(directory, name), "utf8")),
        ),
      ),
    release: (...args: string[]) => {
      const result = spawnSync(
        process.execPath,
        [join(directory, "scripts/release.mjs"), ...args],
        { cwd: directory, env, encoding: "utf8", timeout: 5_000 },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      return result;
    },
  };
}

void test("release CLI accepts canonical stable and rc versions", async (t) => {
  for (const [version, branch] of [
    ["0.0.0", "release/0.0"],
    ["1.2.3", "release/1.2"],
    ["10.20.30-rc.0", "release/10.20"],
    ["1.0.0-rc.12", "release/1.0"],
  ] as const) {
    const fixture = await releaseFixture(t, version, branch);
    const checked = fixture.release("check", version);
    assert.equal(checked.status, 0, checked.stderr);
  }
  const fixture = await releaseFixture(t);
  for (const [version, branch] of [
    ["v1.0.0", "release/1.0"],
    ["01.0.0", "release/01.0"],
    ["1.2", "release/1.2"],
    ["1.2.3-rc.01", "release/1.2"],
    ["1.2.3-rc", "release/1.2"],
    ["1.2.3-beta.1", "release/1.2"],
    ["1.2.3+build.1", "release/1.2"],
    ["1.2.3\n", "release/1.2"],
    ["1.2.3; echo bad", "release/1.2"],
  ] as const) {
    fixture.git("switch", "-C", branch);
    await fixture.writeMetadata(metadata(version));
    assert.notEqual(fixture.release("check", version).status, 0, version);
  }
});

void test("release CLI checks version ordering and leaves rejected preparations untouched", async (t) => {
  for (const [before, after, branch] of [
    ["0.1.9", "0.1.10", "release/0.1"],
    ["1.0.0-rc.9", "1.0.0-rc.10", "release/1.0"],
    ["1.0.0-rc.99", "1.0.0", "release/1.0"],
    ["1.99.99", "2.0.0-rc.1", "release/2.0"],
  ] as const) {
    const fixture = await releaseFixture(t, before, branch);
    const rejected = fixture.release("prepare", before);
    assert.notEqual(rejected.status, 0, before);
    assert.deepEqual(await fixture.readMetadata(), metadata(before));
    const prepared = fixture.release("prepare", after);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.deepEqual(await fixture.readMetadata(), metadata(after));
    assert.equal(fixture.git("rev-list", "--count", "HEAD"), "1");
  }
  const fixture = await releaseFixture(t, "0.1.10");
  assert.notEqual(fixture.release("prepare", "0.1.9").status, 0);
  assert.deepEqual(await fixture.readMetadata(), metadata("0.1.10"));
});

void test("release CLI rejects other branches and mismatched registry metadata", async (t) => {
  const fixture = await releaseFixture(t);
  assert.equal(fixture.release("check", "0.1.0").status, 0);
  for (const branch of [
    "main",
    "staging",
    "dev",
    "release/0",
    "release/0.2",
    "release/00.1",
  ]) {
    fixture.git("switch", "-c", branch);
    assert.notEqual(fixture.release("check").status, 0, branch);
  }
  fixture.git("checkout", "--detach");
  assert.notEqual(fixture.release("check").status, 0);
  fixture.git("switch", "release/0.1");
  for (const [fileIndex, change] of [
    [0, { private: true }],
    [1, { version: "0.1.1" }],
    [2, { name: "jev-bot" }],
  ] as const) {
    const values = metadata();
    values[fileIndex] = { ...values[fileIndex]!, ...change };
    await fixture.writeMetadata(values);
    assert.notEqual(fixture.release("check").status, 0);
    assert.deepEqual(await fixture.readMetadata(), values);
  }
});

void test("maintenance and rc releases cannot move a newer npm channel backwards", () => {
  assert.equal(npmTag("1.0.0"), "latest");
  assert.equal(npmTag("1.1.0-rc.1"), "next");
  assert.equal(npmTag("0.1.2", { latest: "1.0.0" }), "release-0.1");
  assert.equal(npmTag("1.0.1-rc.1", { next: "2.0.0-rc.1" }), "release-1.0-rc");
  assert.equal(npmTag("2.0.0", { latest: "1.0.0" }), "latest");
});

void test("new releases increase within their line; partly published releases can resume", () => {
  assert.throws(() =>
    checkPublishedVersions("0.1.1", { versions: { "0.1.2": {} } }, null),
  );
  assert.throws(() =>
    checkPublishedVersions("0.1.2-rc.3", null, { versions: { "0.1.2": {} } }),
  );
  assert.doesNotThrow(() =>
    checkPublishedVersions("0.1.3", { versions: { "1.0.0": {} } }, null),
  );
  assert.doesNotThrow(() =>
    checkPublishedVersions(
      "0.1.1",
      { versions: { "0.1.1": {}, "0.1.2": {} } },
      null,
    ),
  );
});

void test("an npm retry verifies identity and exact tarball integrity", () => {
  const published = {
    name: packageName,
    version: "0.1.0",
    dist: { integrity: "sha512-same" },
  };
  assert.doesNotThrow(() =>
    verifyNpmVersion(published, "sha512-same", "0.1.0"),
  );
  assert.throws(() => verifyNpmVersion(published, "sha512-different", "0.1.0"));
  assert.throws(() => verifyNpmVersion(published, "sha512-same", "0.1.1"));
});

void test("the npm archive must identify the reviewed package and version", () => {
  assert.doesNotThrow(() =>
    verifyNpmArchiveMetadata({ name: packageName, version: "0.1.0" }, "0.1.0"),
  );
  assert.throws(() =>
    verifyNpmArchiveMetadata(
      { name: "@elsewhere/package", version: "0.1.0" },
      "0.1.0",
    ),
  );
  assert.throws(() =>
    verifyNpmArchiveMetadata({ name: packageName, version: "0.1.1" }, "0.1.0"),
  );
});

function assetFixture(
  existing: Record<string, Buffer>,
  expected: Record<string, Buffer>,
) {
  const stored = { ...existing };
  const uploads: string[] = [];
  return {
    uploads,
    stored,
    transport: {
      list: async () =>
        Object.entries(stored).map(([name, bytes]) => ({
          name,
          size: bytes.length,
          state: "uploaded",
        })),
      download: async (asset: { name: string }) => stored[asset.name],
      upload: async (name: string) => {
        uploads.push(name);
        stored[name] = expected[name]!;
      },
    },
  };
}

void test("GitHub retry verifies present assets and uploads only the missing receipt", async () => {
  const expected = {
    "package.tgz": Buffer.from("archive"),
    "release.json": Buffer.from("receipt"),
  };
  const fixture = assetFixture(
    { "package.tgz": expected["package.tgz"] },
    expected,
  );
  await ensureReleaseAssets(expected, fixture.transport);
  assert.deepEqual(fixture.uploads, ["release.json"]);
  await ensureReleaseAssets(expected, fixture.transport);
  assert.deepEqual(fixture.uploads, ["release.json"]);
});

void test("GitHub mismatch stops before uploading anything else", async () => {
  const expected = {
    "package.tgz": Buffer.from("archive"),
    "release.json": Buffer.from("receipt"),
  };
  const fixture = assetFixture(
    { "release.json": Buffer.from("changed") },
    expected,
  );
  await assert.rejects(
    ensureReleaseAssets(expected, fixture.transport),
    /differs from this release/,
  );
  assert.deepEqual(fixture.uploads, []);
  assert.equal(fixture.stored["release.json"]?.toString(), "changed");
});

void test("a lost GitHub upload response is recovered by verifying bytes on the next run", async () => {
  const expected = { "release.json": Buffer.from("receipt") };
  const fixture = assetFixture({}, expected);
  const upload = fixture.transport.upload;
  fixture.transport.upload = async (name) => {
    await upload(name);
    throw new Error("Connection lost after upload");
  };
  await assert.rejects(
    ensureReleaseAssets(expected, fixture.transport),
    /Connection lost/,
  );
  await ensureReleaseAssets(expected, fixture.transport);
  assert.deepEqual(fixture.uploads, ["release.json"]);
});

void test("GitHub upload success still requires a byte-for-byte readback", async () => {
  const expected = { "release.json": Buffer.from("receipt") };
  const fixture = assetFixture({}, expected);
  fixture.transport.upload = async (name) => {
    fixture.stored[name] = Buffer.from("changed");
  };
  await assert.rejects(
    ensureReleaseAssets(expected, fixture.transport),
    /differs from this release/,
  );
});

void test("a JSR retry verifies every filename, byte count, hash, and export", () => {
  const manifest = { "/dist/index.js": { size: 4, checksum: "sha256-same" } };
  const exports = { ".": "./dist/index.js" };
  assert.doesNotThrow(() =>
    verifyJsrVersion({ manifest, exports }, manifest, exports),
  );
  assert.throws(() =>
    verifyJsrVersion(
      {
        manifest: {
          ...manifest,
          "/extra": { size: 1, checksum: "sha256-extra" },
        },
        exports,
      },
      manifest,
      exports,
    ),
  );
  assert.throws(() =>
    verifyJsrVersion(
      {
        manifest: {
          "/dist/index.js": { size: 4, checksum: "sha256-different" },
        },
        exports,
      },
      manifest,
      exports,
    ),
  );
  assert.throws(() =>
    verifyJsrVersion(
      { manifest, exports: { ".": "./other.js" } },
      manifest,
      exports,
    ),
  );
});

void test("the staged JSR manifest hashes actual bytes recursively", async () => {
  const path = await mkdtemp(join(tmpdir(), "jev-bot-release-"));
  try {
    await mkdir(join(path, "dist"));
    await writeFile(join(path, "dist/index.js"), "hello");
    const manifest = await fileManifest(path);
    assert.deepEqual(manifest, {
      "/dist/index.js": {
        size: 5,
        checksum:
          "sha256-2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      },
    });
  } finally {
    await rm(path, { recursive: true });
  }
});

void test("registry absence requires 404, while outages and bad replies stop publishing", async () => {
  assert.equal(
    await registryJson(
      "https://example.test",
      async () => new Response(null, { status: 404 }),
    ),
    null,
  );
  assert.deepEqual(
    await registryJson("https://example.test", async () =>
      Response.json({ version: "0.1.0" }),
    ),
    { version: "0.1.0" },
  );
  for (const status of [401, 403, 429, 500, 503])
    await assert.rejects(
      registryJson(
        "https://example.test",
        async () => new Response(null, { status }),
      ),
      /Registry request failed/,
    );
  await assert.rejects(
    registryJson("https://example.test", async () => new Response("not JSON")),
  );
});

void test("release CLI prepares reviewable metadata without publishing or committing", async (t) => {
  const fixture = await releaseFixture(t);
  assert.equal(fixture.release("check", "0.1.0").status, 0);
  assert.notEqual(fixture.release("check", "0.1.1").status, 0);
  assert.notEqual(fixture.release("publish", "0.1.0").status, 0);
  assert.deepEqual(await fixture.readMetadata(), metadata("0.1.0"));
  const prepared = fixture.release("prepare", "0.1.1-rc.1");
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.deepEqual(await fixture.readMetadata(), metadata("0.1.1-rc.1"));
  assert.notEqual(fixture.release("prepare", "0.1.1").status, 0);
  assert.deepEqual(await fixture.readMetadata(), metadata("0.1.1-rc.1"));
  assert.equal(fixture.git("rev-list", "--count", "HEAD"), "1");
  assert.deepEqual(fixture.git("diff", "--name-only").split("\n"), [
    "jsr.json",
    "package-lock.json",
    "package.json",
  ]);
});
