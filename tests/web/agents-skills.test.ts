import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";

/** Structural check for Claude Code project agents/skills discovery. */
function frontmatter(path: string): Record<string, string> {
  const text = readFileSync(path, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error(`${path}: missing frontmatter`);
  return Object.fromEntries(
    m[1]!.split("\n").map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
}

const AGENTS = ["planner", "doctor", "db-migration", "worker-service", "web-app", "test-writer", "e2e-test", "ux-verify", "reviewer", "security-audit"];
const SKILLS = [
  "architecture", "db-migration", "delivery-check", "feature-spec", "frontend", "worker-service", "legacy-discovery",
  "local-dev", "plan-guard", "product-ui-design", "project-security-review", "responsive-audit", "testing", "ux-verification",
];
const READ_ONLY = ["planner", "reviewer", "security-audit"];

describe("project agents", () => {
  it("exactly the 10 agents exist", () => {
    expect(readdirSync(".claude/agents").map((f) => f.replace(/\.md$/, "")).sort()).toEqual([...AGENTS].sort());
  });
  it.each(AGENTS)("%s has valid frontmatter", (name) => {
    const fm = frontmatter(`.claude/agents/${name}.md`);
    expect(fm.name).toBe(name);
    expect(fm.description!.length).toBeGreaterThan(40);
    expect(fm.tools).toBeTruthy();
    if (READ_ONLY.includes(name)) expect(fm.tools).not.toMatch(/Edit|Write|Bash/);
  });
});

describe("project skills", () => {
  it("exactly the 14 skills exist", () => {
    expect(readdirSync(".claude/skills").sort()).toEqual([...SKILLS].sort());
  });
  it.each(SKILLS)("%s has SKILL.md with name, description, when/steps/deliverable", (name) => {
    const p = `.claude/skills/${name}/SKILL.md`;
    expect(existsSync(p)).toBe(true);
    const fm = frontmatter(p);
    expect(fm.name).toBe(name);
    expect(fm.description!.length).toBeGreaterThan(40);
    const body = readFileSync(p, "utf8");
    expect(body).toMatch(/## When to use/);
    expect(body).toMatch(/## (Steps|Checklist|Model|Layers|Conventions|Patterns|Design language)/);
    expect(body).toMatch(/## Deliverable/);
  });
});
