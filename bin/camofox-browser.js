#!/usr/bin/env node
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const HELP = `camofox-browser — run the Camofox server or control configured shared identities

Usage:
  camofox-browser                                  Start the Camofox server
  camofox-browser identity open <alias> [--json]   Open a configured shared identity
  camofox-browser identity focus <alias> [--json]  Focus an open shared identity
  camofox-browser identity handoff <alias> <tab-id> <human|agent> [--json]

Configuration:
  CAMOFOX_SERVICE_URL       Camofox service URL (default: http://127.0.0.1:9377)
  CAMOFOX_SERVICE_KEY       Bearer token for the service
  CAMOFOX_IDENTITY_MAP      JSON object mapping local aliases to service user IDs

CAMOFOX_URL, CAMOFOX_ACCESS_KEY, and CAMOFOX_SHARED_IDENTITY_MAP are accepted
as compatibility configuration names. Identity operations never start or restart
the service.
`;

function write(stream, text) {
  stream.write(`${text}\n`);
}

function usage(message, streams) {
  if (message) write(streams.stderr, `camofox-browser: ${message}`);
  write(streams.stderr, HELP.trimEnd());
  return 2;
}

function parseIdentityMap(env) {
  const raw = env.CAMOFOX_IDENTITY_MAP || env.CAMOFOX_SHARED_IDENTITY_MAP;
  if (!raw) throw new CliError(1, 'identity map is not configured; set CAMOFOX_IDENTITY_MAP');
  try {
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('not an object');
    const entries = Object.entries(value).filter(([alias, userId]) => (
      typeof alias === 'string' && alias.trim() && typeof userId === 'string' && userId.trim()
    ));
    if (!entries.length) throw new Error('empty map');
    return Object.fromEntries(entries);
  } catch {
    throw new CliError(1, 'identity map is invalid; set CAMOFOX_IDENTITY_MAP to a JSON object');
  }
}

function serviceUrl(env) {
  const value = env.CAMOFOX_SERVICE_URL || env.CAMOFOX_URL || 'http://127.0.0.1:9377';
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(1, 'service URL is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new CliError(1, 'service URL must be an http(s) URL without embedded credentials');
  }
  return url.toString().replace(/\/$/, '');
}

class CliError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

function statusExitCode(status) {
  if (status === 401) return 3;
  if (status === 403) return 4;
  if (status === 404) return 5;
  if (status === 409) return 6;
  if (status === 429 || status >= 500) return 8;
  return 1;
}

async function request({ action, alias, tabId, handoff, env, fetchImpl }) {
  const identities = parseIdentityMap(env);
  const userId = identities[alias];
  if (!userId) throw new CliError(5, `identity alias "${alias}" is not configured`);

  const key = env.CAMOFOX_SERVICE_KEY || env.CAMOFOX_ACCESS_KEY || env.CAMOFOX_API_KEY;
  if (!key) throw new CliError(3, 'service credential is unavailable; set CAMOFOX_SERVICE_KEY');

  const url = serviceUrl(env);
  const route = action === 'handoff'
    ? `/tabs/${encodeURIComponent(tabId)}/handoff`
    : `/browser/identities/${encodeURIComponent(userId)}/${action}`;
  const body = action === 'handoff' ? { userId, handoff } : {};

  let response;
  try {
    response = await fetchImpl(`${url}${route}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new CliError(8, `identity ${action} could not reach the service; retry after checking CAMOFOX_SERVICE_URL`);
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // Do not expose arbitrary response content in a local CLI error.
  }
  if (!response.ok || !payload?.ok) {
    // Provider error bodies can reflect credentials or private browser state.
    // Keep the status useful while never echoing untrusted service text.
    throw new CliError(statusExitCode(response.status), `identity ${action} failed (${response.status})`);
  }
  return payload;
}

function parseIdentityArguments(args, streams) {
  const json = args.includes('--json');
  const clean = args.filter(arg => arg !== '--json');
  if (clean.includes('--help') || clean.includes('-h')) return { help: true };

  let action;
  let alias;
  let tabId;
  let handoff;
  if (['open', 'focus'].includes(clean[0])) {
    [action, alias] = clean;
  } else if (clean[0] === 'handoff') {
    [action, alias, tabId, handoff] = clean;
  } else if (clean.length === 1 || ['open', 'focus'].includes(clean[1])) {
    // Preserve the retired command's familiar alias-first open/focus spelling.
    [alias, action = 'open'] = clean;
  } else {
    return { error: usage('expected an identity action', streams) };
  }

  if (!['open', 'focus', 'handoff'].includes(action) || !alias ||
      (action === 'handoff' && (!tabId || !['human', 'agent'].includes(handoff))) ||
      (action !== 'handoff' && clean.length !== 2 && !(clean.length === 1 && action === 'open'))) {
    return { error: usage('invalid identity arguments', streams) };
  }
  return { action, alias, tabId, handoff, json };
}

export async function main(argv = process.argv.slice(2), {
  env = process.env,
  fetchImpl = globalThis.fetch,
  startServer = async () => import('../server.js'),
  streams = { stdout: process.stdout, stderr: process.stderr },
} = {}) {
  if (!argv.length) {
    await startServer();
    return 0;
  }
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    write(streams.stdout, HELP.trimEnd());
    return 0;
  }
  if (argv.length === 1 && ['--version', '-v'].includes(argv[0])) {
    write(streams.stdout, version);
    return 0;
  }
  if (argv[0] !== 'identity') return usage(`unknown command "${argv[0]}"`, streams);

  const parsed = parseIdentityArguments(argv.slice(1), streams);
  if (parsed.help) {
    write(streams.stdout, HELP.trimEnd());
    return 0;
  }
  if (parsed.error) return parsed.error;

  try {
    const result = await request({ ...parsed, env, fetchImpl });
    if (parsed.json) write(streams.stdout, JSON.stringify(result));
    else if (parsed.action === 'handoff') write(streams.stdout, `${parsed.alias}: handed off to ${parsed.handoff}`);
    else write(streams.stdout, `${parsed.alias}: ${parsed.action}ed${result.tabId ? ` (tab ${result.tabId})` : ''}`);
    return 0;
  } catch (error) {
    const code = error instanceof CliError ? error.exitCode : 1;
    write(streams.stderr, `camofox-browser: ${error instanceof Error ? error.message : 'identity command failed'}`);
    return code;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`camofox-browser: ${error instanceof Error ? error.message : 'failed to start server'}\n`);
    process.exitCode = 1;
  });
}
