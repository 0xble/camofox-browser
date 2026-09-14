import { describe, test, expect } from '@jest/globals';
import fs from 'fs';
import { TOOL_NAMES } from '../../lib/mcp-tool-contracts.mjs';

// OpenClaw's manifest schema accepts tool ownership through contracts.tools. The
// package metadata mirrors it for package consumers; the legacy top-level tools
// field is intentionally absent because current OpenClaw rejects it.

function readJson(rel) {
  return JSON.parse(fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));
}

describe('OpenClaw manifest', () => {
  test('declares ownership contracts for every canonical tool', () => {
    const manifest = readJson('openclaw.plugin.json');
    const pkg = readJson('package.json');

    const packageTools = pkg.openclaw.tools.map((tool) => tool.name);

    expect(manifest.contracts.tools).toEqual(TOOL_NAMES);
    expect(manifest).not.toHaveProperty('tools');
    expect(packageTools).toEqual(TOOL_NAMES);
  });
});
