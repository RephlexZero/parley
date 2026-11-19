import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Config } from "../config.ts";
import type { Domain, Project } from "./types.ts";

/** A session belongs to a project if it runs in it, in a worktree under it, or in a same-named folder (repos move). */
export function inProject(sessionCwd: string, projectPath: string): boolean {
  return (
    sessionCwd === projectPath ||
    sessionCwd.startsWith(projectPath + "/") ||
    basename(sessionCwd) === basename(projectPath)
  );
}

export function domainOf(path: string, cfg: Config["projects"]): Domain {
  const p = path.toLowerCase() + "/";
  if (cfg.workMarkers.some((m) => p.includes(m.toLowerCase()))) return "work";
  if (cfg.uniMarkers.some((m) => p.includes(m.toLowerCase()))) return "uni";
  if (p.includes("/personal/")) return "personal";
  return "other";
}

/** "tidepool" -> ["tidepool", "tide pool"]; "wheel-tuning" -> ["wheel tuning", "wheel", "tuning"]. */
export function aliasesFor(name: string): string[] {
  const lower = name.toLowerCase();
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const out = new Set<string>([lower, words.join(" ")]);
  if (words.length > 1) for (const w of words) if (w.length >= 4) out.add(w);
  return [...out];
}

const isProject = (dir: string) =>
  existsSync(join(dir, ".git")) || existsSync(join(dir, "CLAUDE.md")) || existsSync(join(dir, "AGENTS.md"));

const children = (dir: string) => {
  try {
    return readdirSync(dir)
      .filter((n) => !n.startsWith(".") && n !== "node_modules" && n !== "target")
      .map((n) => join(dir, n))
      .filter((p) => statSync(p, { throwIfNoEntry: false })?.isDirectory());
  } catch {
    return [];
  }
};

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

const clean = (s: string) =>
  s
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s*\|\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * What a parent folder's CLAUDE.md says about a project: the rest of the line
 * that names it, e.g. "| `parley/` | Discord voice assistant ... |" or
 * "- `coursework-notes/` — modules, revision notes, coursework ...".
 */
export function noteFromParent(name: string, parentDoc: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Only rows and bullets that start with the name, not passing mentions.
  const mention = new RegExp("^[\\s|*-]*(`[\\w./-]+/`,?\\s*)*`(?:[\\w.-]+/)*" + esc + "/`");
  const lines = parentDoc.split("\n");
  const i = lines.findIndex((l) => mention.test(l));
  if (i < 0) return "";
  let rest = lines[i] ?? "";
  // A bullet's wrapped continuation lines.
  for (let j = i + 1; j < lines.length && /^\s{2,}\S/.test(lines[j] ?? "") && !/^\s*[-*|]/.test(lines[j] ?? ""); j++)
    rest += " " + (lines[j] ?? "").trim();
  for (;;) {
    const next = rest.replace(/^[\s,|—–:-]*`[^`]*`/, ""); // the name, and any siblings sharing the row
    if (next === rest) break;
    rest = next;
  }
  return clean(rest.replace(/^[\s,|—–:-]+/, ""));
}

/** First line of prose in a project's own README or CLAUDE.md. */
function ownNote(path: string): string {
  for (const f of ["README.md", "CLAUDE.md", "AGENTS.md"]) {
    for (const l of read(join(path, f)).split("\n")) {
      const t = l.trim();
      if (t.length < 25 || /^(#|-|\*|\||>|```|<|!|\[|\d+\.)/.test(t)) continue;
      return clean(t);
    }
  }
  return "";
}

const BORING = new Set([
  "src",
  "docs",
  "doc",
  "test",
  "tests",
  "scripts",
  "tools",
  "assets",
  "build",
  "dist",
  "lib",
  "bin",
]);
const COURSE_CODE = /^[a-z]{2,4}\d{4,6}$/;

/** Top-level folders, plus second-level ones with spaced names ("coursework/EE10101 Digital Circuits"). */
function contents(path: string): { summary: string; named: string[] } {
  const named: string[] = [];
  const parts = children(path)
    .filter((d) => !BORING.has(basename(d).toLowerCase()))
    .slice(0, 10)
    .map((d) => {
      const inner = children(d)
        .map((c) => basename(c))
        .filter((n) => n.includes(" "));
      named.push(...inner);
      return inner.length ? `${basename(d)} (${inner.slice(0, 4).join(", ")})` : basename(d);
    });
  return { summary: parts.join(", "), named };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** Every git repo or CLAUDE.md folder one or two levels under the roots. */
export function scanProjects(cfg: Config["projects"]): Project[] {
  const found = new Map<string, Project>();
  const add = (path: string) => {
    if (found.has(path)) return;
    const name = basename(path);
    const parentDocs = [dirname(path), dirname(dirname(path))].map((d) => read(join(d, "CLAUDE.md")));
    const note = parentDocs.map((d) => noteFromParent(name, d)).find(Boolean) || ownNote(path);
    const inside = contents(path);
    const aliases = new Set([...aliasesFor(name), ...(cfg.aliases[name] ?? [])]);
    for (const n of inside.named) {
      aliases.add(n.toLowerCase());
      for (const w of n.toLowerCase().split(/\s+/)) if (COURSE_CODE.test(w)) aliases.add(w);
    }
    const description = [note && clip(note, 160), inside.summary && `folders: ${clip(inside.summary, 140)}`]
      .filter(Boolean)
      .join("; ");
    found.set(path, { name, path, domain: domainOf(path, cfg), aliases: [...aliases], description });
  };
  for (const root of cfg.roots) {
    for (const a of children(root)) {
      if (isProject(a)) add(a);
      else for (const b of children(a)) if (isProject(b)) add(b);
    }
  }
  return [...found.values()];
}
