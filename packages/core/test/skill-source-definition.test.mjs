import assert from "node:assert/strict";
import test from "node:test";
import { parseSkillFrontMatter, splitMarkdownFrontMatter } from "../dist/skill-source-definition.js";

test("YAML routing metadata retains complete folded and literal descriptions", () => {
  assert.equal(parseSkillFrontMatter("---\nname: review\ndescription: >\n  First line.\n  Second line.\n---\n# Body\n").frontMatter.description, "First line. Second line.");
  assert.equal(parseSkillFrontMatter("---\r\nname: review\r\ndescription: |\r\n  First line.\r\n  Second line.\r\n---\r\n# Body\r\n").frontMatter.description, "First line.\nSecond line.");
});

test("front matter closes only on an exact delimiter line", () => {
  const text = "---\n---suffix: retained\nname: review\ndescription: Current rules.\n---\n# Body\n";
  assert.equal(parseSkillFrontMatter(text).frontMatter.description, "Current rules.");
  assert.equal(splitMarkdownFrontMatter(text).body, "# Body\n");
  assert.equal(splitMarkdownFrontMatter("---\nname: review\n---").body, "");
});

for (const text of ["# No metadata\n", "---\n[name, description]\n---\n", "---\nname: [\n---\n"]) {
  test(`invalid metadata remains a warning without inventing routing content: ${JSON.stringify(text)}`, () => {
    const parsed = parseSkillFrontMatter(text);
    assert.deepEqual(parsed.frontMatter, {});
    assert.equal(parsed.warnings[0].code, "missing_metadata");
  });
}

test("YAML alias expansion is bounded and cannot crash registry reads", () => {
  const parsed = parseSkillFrontMatter("---\na: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\nname: review\ndescription: *c\n---\n# Body\n");
  assert.deepEqual(parsed.frontMatter, {});
  assert.match(parsed.warnings[0].message, /alias limits/);
});
