import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { ROOT } from "./test-harness/cdp.mjs";

const ROOT_DOCS = [
  "AGENTS.md",
  "README.md",
  "CHANGELOG.md",
];

const ACTIVE_DOCS = join(ROOT, "docs");
const SKIP_DOCS = new Set(["ROADMAP_HISTORY.md"]);
const LINK_PATTERN = /!?\[[^\]]*\]\(([^)]+)\)/g;
const EXTERNAL_PATTERN = /^(?:https?:|mailto:|codex:|data:|asset:)/i;

let failures = 0;
let checks = 0;

function fail(message) {
  failures++;
  console.error(`[FAIL] ${message}`);
}

function pass(message) {
  checks++;
  console.log(`[PASS] ${message}`);
}

function activeMarkdownFiles() {
  const files = ROOT_DOCS.map((name) => join(ROOT, name)).filter(existsSync);
  for (const entry of readdirSync(ACTIVE_DOCS, { withFileTypes: true })) {
    if (!entry.isFile() || extname(entry.name) !== ".md" || SKIP_DOCS.has(entry.name)) continue;
    files.push(join(ACTIVE_DOCS, entry.name));
  }
  return files;
}

function parseLink(raw) {
  let value = raw.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  if (/^[^/]+\.md\s+["']/.test(value)) value = value.split(/\s+/, 1)[0];
  return value;
}

function checkMarkdown(file) {
  const relative = normalize(file.slice(ROOT.length + 1));
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    fail(`${relative}: cannot read as UTF-8 (${error.message})`);
    return;
  }
  if (text.includes("\uFFFD")) fail(`${relative}: contains U+FFFD replacement characters`);

  let links = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const target = parseLink(match[1]);
    if (!target || target.startsWith("#") || EXTERNAL_PATTERN.test(target)) continue;
    links++;
    let pathPart;
    try {
      pathPart = decodeURIComponent(target.split("#", 1)[0].replace(/\\/g, "/"));
    } catch {
      fail(`${relative}: malformed URL encoding in link ${target}`);
      continue;
    }
    if (!pathPart) continue;
    const resolved = pathPart.startsWith("/")
      ? resolve(ROOT, `.${pathPart}`)
      : resolve(dirname(file), pathPart);
    if (!existsSync(resolved)) fail(`${relative}: missing local link target ${target}`);
  }
  pass(`${relative}: ${links} local link(s) checked`);
}

function checkManifest() {
  const manifestPath = join(ROOT, "scripts", "test-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const [id, suite] of Object.entries(manifest.suites ?? {})) {
    const file = join(ROOT, "scripts", "test-harness", suite.module);
    if (!existsSync(file) || !statSync(file).isFile()) fail(`test suite ${id}: missing ${suite.module}`);
  }
  for (const [group, scripts] of Object.entries(manifest.legacyGroups ?? {})) {
    for (const script of scripts) {
      if (!existsSync(join(ROOT, script))) fail(`legacy group ${group}: missing ${script}`);
    }
  }
  pass(`test manifest: ${Object.keys(manifest.suites ?? {}).length} harness suite(s)`);
}

for (const file of activeMarkdownFiles()) checkMarkdown(file);
checkManifest();

console.log(`DOCS ${failures === 0 ? "PASS" : "FAIL"} (${checks} check(s), ${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);
