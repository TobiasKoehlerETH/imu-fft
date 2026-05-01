import { readFile, writeFile } from "node:fs/promises";

const versionPattern = /^\d+\.\d+\.\d+$/;
const validBumps = new Set(["major", "minor", "patch"]);

const args = process.argv.slice(2);
const mode = args[0];
const value = args[1];

if (!["--bump", "--set", "--check"].includes(mode) || !value) {
  fail("Usage: node scripts/bump-version.mjs --bump major|minor|patch | --set X.Y.Z | --check X.Y.Z");
}

const packageJson = await readJson("package.json");
const packageLock = await readJson("package-lock.json");
const tauriConfig = await readJson("src-tauri/tauri.conf.json");
const cargoToml = await readFile("src-tauri/Cargo.toml", "utf8");
const currentVersion = String(packageJson.version);

if (!versionPattern.test(currentVersion)) {
  fail(`package.json version must be SemVer X.Y.Z, got ${currentVersion}`);
}

const nextVersion = resolveNextVersion(mode, value, currentVersion);

if (mode === "--check") {
  assertVersion("package-lock.json", packageLock.version, nextVersion);
  assertVersion("package-lock.json packages root", packageLock.packages?.[""]?.version, nextVersion);
  assertVersion("src-tauri/tauri.conf.json", tauriConfig.version, nextVersion);
  assertVersion("src-tauri/Cargo.toml", readCargoVersion(cargoToml), nextVersion);
  console.log(nextVersion);
  process.exit(0);
}

packageJson.version = nextVersion;
packageLock.version = nextVersion;
if (packageLock.packages?.[""]) {
  packageLock.packages[""].version = nextVersion;
}
tauriConfig.version = nextVersion;

const updatedCargoToml = updateCargoVersion(cargoToml, nextVersion);

await writeJson("package.json", packageJson);
await writeJson("package-lock.json", packageLock);
await writeJson("src-tauri/tauri.conf.json", tauriConfig);
await writeFile("src-tauri/Cargo.toml", updatedCargoToml);

console.log(nextVersion);

function resolveNextVersion(selectedMode, selectedValue, version) {
  if (selectedMode === "--set" || selectedMode === "--check") {
    if (!versionPattern.test(selectedValue)) {
      fail(`Version must be SemVer X.Y.Z, got ${selectedValue}`);
    }
    return selectedValue;
  }

  if (!validBumps.has(selectedValue)) {
    fail(`Bump must be one of major, minor, or patch, got ${selectedValue}`);
  }

  const [major, minor, patch] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (selectedValue === "major") {
    return `${major + 1}.0.0`;
  }
  if (selectedValue === "minor") {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readCargoVersion(contents) {
  const match = contents.match(/^\[package\][\s\S]*?^version = "([^"]+)"/m);
  if (!match) {
    fail("Could not find [package] version in src-tauri/Cargo.toml");
  }
  return match[1];
}

function updateCargoVersion(contents, version) {
  if (readCargoVersion(contents) === version) {
    return contents;
  }
  return contents.replace(/^(\[package\][\s\S]*?^version = )"[^"]+"/m, `$1"${version}"`);
}

function assertVersion(source, actual, expected) {
  if (actual !== expected) {
    fail(`${source} version ${actual ?? "<missing>"} does not match ${expected}`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
