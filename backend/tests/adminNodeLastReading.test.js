const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Regression: the admin node list showed "Last reading: Never" for every node
// because the $lookup compared nodeId with the literal text "$$nodeId". Variables
// from `let` only evaluate inside $expr.
test('admin node list matches readings with $expr, not a literal "$$nodeId" string', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'admin', 'adminNodeController.js'), 'utf8');
  assert.ok(!/\{\s*\$match:\s*\{\s*nodeId:\s*'\$\$nodeId'\s*\}\s*\}/.test(source),
    'a plain { nodeId: "$$nodeId" } match never matches');
  assert.match(source, /\$expr:\s*\{\s*\$eq:\s*\['\$nodeId',\s*'\$\$nodeId'\]\s*\}/);
});
