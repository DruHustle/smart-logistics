import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
// Require through Vite's actual dependency graph: pnpm does not publicly hoist transitive modules.
const requireFromVite = createRequire(import.meta.resolve("vite"));
test("Vite resolves the reviewed local picomatch mitigation and rejects repeated-extglob ReDoS", () => {
  const match = requireFromVite("picomatch");
  const installed = requireFromVite("picomatch/package.json");
  assert.equal(installed.name, "picomatch");
  assert.equal(installed.version, "4.0.8-onesa.1");
  for (const pattern of ["+(*)", "+(*a)", "+(a*)", "*(a*|b)", "+(ab|abab)"]) {
    assert.equal(match.makeRe(pattern).test("a".repeat(150) + "!"), false, pattern);
    assert.equal(match.isMatch("a".repeat(150) + "!", pattern), false, pattern);
    assert.equal(match.isMatch(pattern, pattern), true, "unsupported risky glob stays literal");
  }
  assert.equal(match.isMatch("src/.private/notes.ts", "src/**/*.ts", {dot:true}), true);
  assert.equal(match.isMatch("src/a.js", "src/**/*.ts", {dot:true}), false);
  assert.equal(match.isMatch("file.tsx", "*.{ts,tsx}"), true);
  assert.equal(match.isMatch("fff", "*(f)"), true);
});
