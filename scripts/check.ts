#!/usr/bin/env bun
// Repo gate: valid skills, no personal paths, no obvious secrets. Run before every commit.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = join(import.meta.dir, "..");
const errors: string[] = [];
const SKIP = new Set([".git", ".held", "node_modules"]);
// Build output, skipped by full path so a skill's own bin/ or dist/ is still scanned.
const SKIP_PATHS = new Set(["tools/delegate/bin", "tools/delegate/dist"]);
const THIS_FILE = join("scripts", "check.ts");
const BANNED: [RegExp, string][] = [
  [/\/Users\/[a-z]/, "absolute home path"],
  [/\b(sk-[A-Za-z0-9-]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/, "token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
];
// Private names stay out of the public repo: one per line in the untracked .check-names.
const namesFile = join(root, ".check-names");
if (existsSync(namesFile)) {
  for (const name of readFileSync(namesFile, "utf8").split("\n").map((n) => n.trim()).filter(Boolean)) {
    BANNED.push([new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), `private name "${name}"`]);
  }
}

function walk(dir: string, rel = ""): void {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name === ".DS_Store" || name === ".check-names") continue;
    const path = join(dir, name);
    const relPath = join(rel, name);
    if (relPath === "tools/delegate/.test-runs" || SKIP_PATHS.has(relPath)) continue;
    if (statSync(path).isDirectory()) {
      // Symlinked skill folders are checked at their real location.
      if (realpathSync(path) === path) walk(path, relPath);
      continue;
    }
    if (relPath === THIS_FILE) continue;
    const text = readFileSync(path, "utf8");
    if (relPath.endsWith(".md") && text.includes("\u2014")) errors.push(`${relPath}: em-dash`);
    if (relPath.startsWith("skills/") && relPath.endsWith(".md")) {
      for (const m of text.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)) {
        const target = m[1].trim();
        if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
        if (!existsSync(resolve(dirname(path), target))) errors.push(`${relPath}: broken link "${target}"`);
      }
    }
    for (const [re, label] of BANNED) if (re.test(text)) errors.push(`${relPath}: ${label}`);
  }
}
walk(root);

const skillsDir = join(root, "skills");
const skills = readdirSync(skillsDir).filter((s) => statSync(join(skillsDir, s)).isDirectory());
for (const skill of skills) {
  let text = "";
  try {
    text = readFileSync(join(skillsDir, skill, "SKILL.md"), "utf8");
  } catch {
    errors.push(`skills/${skill}: missing SKILL.md`);
    continue;
  }
  const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const name = front.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = front.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (name !== skill) errors.push(`skills/${skill}: name is "${name}"`);
  if (!description) errors.push(`skills/${skill}: no description`);
  else if (description.length > 1024) errors.push(`skills/${skill}: description over 1024 chars`);
}

for (const file of ["skills.sh.json"]) JSON.parse(readFileSync(join(root, file), "utf8"));

// One plugin, four stores: every manifest must parse and carry the same version.
const MANIFESTS = [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", ".codex-plugin/plugin.json", ".agents/plugins/marketplace.json", "gemini-extension.json"];
const versions = new Map<string, string>();
for (const file of MANIFESTS) {
  try {
    const json = JSON.parse(readFileSync(join(root, file), "utf8"));
    const version = json.version ?? json.plugins?.[0]?.version;
    if (version) versions.set(file, version);
    else if (!file.endsWith("marketplace.json")) errors.push(`${file}: no version`);
  } catch (error) {
    errors.push(`${file}: ${String(error)}`);
  }
}
if (new Set(versions.values()).size > 1) errors.push(`plugin versions differ: ${[...versions].map(([f, v]) => `${f}=${v}`).join(", ")}`);

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`ok: ${skills.length} skills`);
