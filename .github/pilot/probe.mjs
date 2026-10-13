// The hermetic tier's Windows pilot, never merged: each profiled CLI runs on
// windows-latest against aimock, through the real `pixtuoid connect` and shim,
// into a named-pipe tee that feeds a headless pixtuoid, and every byte is kept
// for reading. One run per variant; the variants are the unknowns of the
// spec's "Windows arm: what blocks it".
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const REPO = process.cwd();
const BIN = path.join(REPO, 'target', 'debug');
const OUT = path.join(REPO, 'pilot-out');
const ROOT = path.join(process.env.RUNNER_TEMP, 'pilot');
const SCRIPTS = path.join(REPO, 'crates', 'pixtuoid-core', 'tests', 'sources', 'hermetic');
const AIMOCK = path.join(SCRIPTS, 'aimock', 'node_modules', '@copilotkit', 'aimock', 'dist', 'cli.js');
const PROMPT = 'Read NOTE.txt, then list this directory, then read NOTE.txt again.';
const KEY = 'hermetic-dummy-key';
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const CLI_TIMEOUT_MS = 180_000;
const only = process.env.PILOT_ONLY ? new RegExp(process.env.PILOT_ONLY) : null;

const INHERITED = [
  'PATH', 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles',
  'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ProgramData', 'SystemDrive',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME', 'LANG', 'TERM',
];

const CLIS = {
  'claude-code': { pkg: '@anthropic-ai/claude-code', version: '2.1.278', bin: 'claude', homeEnv: 'CLAUDE_CONFIG_DIR' },
  codex: { pkg: '@openai/codex', version: '0.155.1', bin: 'codex', homeEnv: 'CODEX_HOME' },
  opencode: { pkg: '@opencode/cli', version: '2.0.27', bin: 'opencode', homeEnv: 'OPENCODE_CONFIG_DIR' },
  dsh: { pkg: '@deepseek-ai/dsh', version: '0.2.0-rc.2', bin: 'dsh', homeEnv: 'DSH_HOME' },
};

const CODEX_CONFIG = (port) => `model = "gpt-5.5"
model_provider = "aimock"
model_reasoning_effort = "high"

[model_providers.aimock]
name = "aimock"
base_url = "http://127.0.0.1:${port}/v1"
env_key = "HERMETIC_API_KEY"
wire_api = "responses"
`;
const OPENCODE_CONFIG = (port) => JSON.stringify({
  providers: { openai: { settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: KEY }, models: { 'gpt-5.2': {} } } },
}, null, 2);

const noGit = (p) => !/\\git\\/i.test(p);

const DSH_PWSH_PERMISSION = {
  fixtures: [
    { match: { systemMessage: 'Create a concise title' }, response: { content: 'Hermetic' } },
    {
      match: { hasToolResult: false },
      response: {
        reasoning: 'The note needs wider access.',
        toolCalls: [{ name: 'pwsh', arguments: { command: 'Get-Content NOTE.txt', description: 'Read the note', sandbox_permissions: 'danger-full-access', justification: 'The note needs wider access.' } }],
        usage: { input_tokens: 12, output_tokens: 7 },
      },
    },
    { match: { hasToolResult: true }, response: { content: 'refused', usage: { input_tokens: 12, output_tokens: 7 } } },
  ],
};

const RUNS = [
  { id: 'claude-code.tool-run', source: 'claude-code', script: 'claude-code/tool-run.json', args: ['-p', PROMPT],
    env: (port) => ({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1' }) },
  { id: 'claude-code.no-git-on-path', base: 'claude-code.tool-run', pathFilter: noGit },
  { id: 'claude-code.git-bash-path-only', base: 'claude-code.tool-run', pathFilter: noGit, extra: { CLAUDE_CODE_GIT_BASH_PATH: GIT_BASH } },
  // Round 2: the sandbox under %TEMP%, which the runner spells in 8.3 form.
  { id: 'claude-code.sandbox-in-temp', base: 'claude-code.tool-run', sandboxRoot: process.env.TEMP },
  { id: 'codex.tool-run', source: 'codex', script: 'codex/tool-run.json', args: ['exec', '--dangerously-bypass-hook-trust', PROMPT],
    env: () => ({ HERMETIC_API_KEY: KEY }), config: [{ home: 'CODEX_HOME', path: 'config.toml', body: CODEX_CONFIG }] },
  // CODEX_HOME unset: does codex find `~/.codex` through USERPROFILE (the sandbox) or the known-folder API (the runner's)?
  { id: 'codex.home-from-userprofile', base: 'codex.tool-run', noHomeEnv: true, config: [{ home: 'USERPROFILE', path: '.codex/config.toml', body: CODEX_CONFIG }] },
  // Round 2: read-only exec on Windows is Forbidden without a sandbox backend
  // (codex-rs/core/src/exec_policy.rs:789-806 at rust-v0.155.1); `[windows]
  // sandbox` picks one (core/src/windows_sandbox.rs:25-49).
  ...['unelevated', 'elevated'].map((mode) => ({
    id: `codex.windows-sandbox-${mode}`, base: 'codex.tool-run',
    config: [{ home: 'CODEX_HOME', path: 'config.toml', body: (port) => `${CODEX_CONFIG(port)}\n[windows]\nsandbox = "${mode}"\n` }],
  })),
  { id: 'codex.danger-full-access', base: 'codex.tool-run', args: ['exec', '--dangerously-bypass-hook-trust', '--sandbox', 'danger-full-access', PROMPT] },
  ...[1, 2, 3].map((n) => ({
    id: `opencode.tool-run-${n}`, source: 'opencode', script: 'opencode/tool-run.json',
    args: ['run', '--standalone', '--model', 'openai/gpt-5.2', PROMPT],
    env: () => ({ OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' }),
    config: [{ home: 'OPENCODE_CONFIG_DIR', path: 'opencode.jsonc', body: OPENCODE_CONFIG }],
  })),
  ...['tool-run', 'permission', 'subagent'].map((s) => ({
    id: `dsh.${s}`, source: 'dsh', script: `dsh/${s}.json`, args: ['--profile', 'headless', PROMPT],
    env: (port) => ({ DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}`, DEEPSEEK_API_KEY: KEY, DSH_TELEMETRY_DISABLED: '1' }),
  })),
  { id: 'dsh.permission-pwsh', base: 'dsh.permission', scriptBody: DSH_PWSH_PERMISSION },
];

function resolveRun(r) {
  if (!r.base) return r;
  const base = resolveRun(RUNS.find((b) => b.id === r.base));
  return { ...base, ...r };
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const write = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
const say = (...a) => console.log('[pilot]', ...a);

function hostEnvOf(names) {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (want.has(k.toLowerCase())) env[k] = v;
  return env;
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, error: r.error?.message };
}

function facts() {
  const lines = [];
  const add = (k, v) => lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  for (const k of ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'RUNNER_TEMP', 'USERNAME', 'ComSpec', 'PATHEXT']) add(k, process.env[k] ?? '<unset>');
  add('TEMP realpath', fs.realpathSync.native(process.env.TEMP));
  add('PATH', (process.env.PATH ?? '').split(';'));
  add('node', process.version);
  for (const [cmd, args] of [['npm', ['-v']], ['git', ['--version']], ['where', ['bash']], ['where', ['git']], ['where', ['pwsh']], ['where', ['powershell']]]) {
    add(`${cmd} ${args.join(' ')}`, (cmd === 'npm' ? sh('npm -v', [], { shell: true }) : sh(cmd, args)).out.trim());
  }
  // git(1)'s GIT_CONFIG_GLOBAL=/dev/null, as the recorder's `git_in` sets it, and NUL.
  for (const dev of ['/dev/null', 'NUL']) {
    const r = sh('git', ['config', '--global', '--list'], { env: { ...process.env, GIT_CONFIG_GLOBAL: dev, GIT_CONFIG_SYSTEM: dev } });
    add(`git config --global --list with ${dev}`, `exit ${r.status}: ${r.out.trim()}`);
  }
  // A readiness probe that opens no pipe instance: enumerate the namespace.
  try { add('readdir \\\\.\\pipe\\ works', `${fs.readdirSync('\\\\.\\pipe\\').length} entries`); } catch (e) { add('readdir \\\\.\\pipe\\ fails', e.message); }
  write(path.join(OUT, 'facts.txt'), `${lines.join('\n')}\n`);
}

function install(source) {
  const c = CLIS[source];
  const dir = path.join(ROOT, 'cli', source);
  const spec = `${c.pkg}@${c.version}`;
  write(path.join(dir, 'package.json'), JSON.stringify({ private: true, allowScripts: { [spec]: true } }));
  // A `.cmd` runs only under cmd.exe, and `shell` with an args array is DEP0190
  // (nodejs.org/api/child_process.html, "Spawning .bat and .cmd files on Windows").
  const r = sh(`npm install ${spec} --no-audit --no-fund`, [], { cwd: dir, shell: true });
  write(path.join(OUT, 'install', `${source}.log`), `exit ${r.status}\n${r.out}`);
  const pkgDir = path.join(dir, 'node_modules', ...c.pkg.split('/'));
  const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const rel = typeof pj.bin === 'string' ? pj.bin : pj.bin[c.bin];
  const entry = path.join(pkgDir, rel);
  const head = fs.readFileSync(entry).subarray(0, 128).toString('latin1');
  const viaNode = /\.(c|m)?js$/i.test(entry) || (head.startsWith('#!') && head.includes('node'));
  const binDir = path.join(dir, 'node_modules', '.bin');
  const record = { spec, status: r.status, bin: pj.bin, entry, viaNode, head: head.split('\n')[0], dotBin: fs.readdirSync(binDir) };
  write(path.join(OUT, 'install', `${source}.json`), JSON.stringify(record, null, 2));
  return { argv: viaNode ? [process.execPath, entry] : [entry], binDir, record };
}

function freePort() {
  return new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
}

function httpGet(port, p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: p, timeout: 5000 }, (r) => {
      let b = ''; r.setEncoding('utf8'); r.on('data', (d) => (b += d)); r.on('end', () => (r.statusCode === 200 ? res(b) : rej(new Error(`${p}: ${r.statusCode}`))));
    }).on('error', rej);
  });
}

async function until(ready, what, ms = 60_000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await ready()) return Date.now() - t; await sleep(200); }
  throw new Error(`${what} never came up`);
}

const pipeListed = (name) => { try { return fs.readdirSync('\\\\.\\pipe\\').includes(name); } catch { return false; } };

function kill(child) {
  if (child?.pid && child.exitCode === null) sh('taskkill', ['/pid', String(child.pid), '/T', '/F']);
}

// The recorder's listener, as W2 would make it: one connection per payload,
// kept raw and forwarded in arrival order to the headless scene's pipe.
async function tee(name, file, sceneName) {
  const got = [];
  let chain = Promise.resolve();
  const forwardErrors = [];
  const forward = (buf) => async () => {
    for (let i = 0; i < 50; i += 1) {
      try {
        await new Promise((res, rej) => { const s = net.connect(`\\\\.\\pipe\\${sceneName}`, () => s.end(buf, res)); s.on('error', rej); });
        return;
      } catch (e) { if (i === 49) forwardErrors.push(e.code ?? e.message); await sleep(100); }
    }
  };
  const server = net.createServer((c) => {
    let buf = '';
    c.setEncoding('utf8');
    c.on('data', (d) => (buf += d));
    c.on('error', (e) => forwardErrors.push(`inbound ${e.code}`));
    c.on('end', () => {
      if (!buf.trim()) return;
      got.push(Date.now());
      fs.appendFileSync(file, buf.endsWith('\n') ? buf : `${buf}\n`);
      chain = chain.then(forward(buf));
    });
  });
  await new Promise((res, rej) => server.listen(`\\\\.\\pipe\\${name}`, res).on('error', rej));
  return { got, server, forwardErrors, drained: () => chain };
}

function copySmallTree(from, to, budget = { files: 400 }) {
  if (!fs.existsSync(from)) return;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (budget.files <= 0) return;
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') copySmallTree(src, dst, budget); continue; }
    const st = fs.statSync(src);
    budget.files -= 1;
    if (st.size < 2_000_000) { fs.mkdirSync(to, { recursive: true }); fs.copyFileSync(src, dst); }
  }
}

function eventsOf(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
    try { const v = JSON.parse(l); return v.hook_event_name ?? v.type ?? '?'; } catch { return 'NOT-JSON'; }
  });
}

async function runOne(r, cli) {
  const out = path.join(OUT, 'runs', r.id);
  fs.mkdirSync(out, { recursive: true });
  const result = { id: r.id };
  const sb = path.join(r.sandboxRoot ?? ROOT, 'sandbox', r.id);
  fs.rmSync(sb, { recursive: true, force: true });
  const at = (rel) => { const d = path.join(sb, rel); fs.mkdirSync(d, { recursive: true }); return d; };
  const port = await freePort();
  const children = [];
  try {
    const bin = at('bin');
    fs.copyFileSync(path.join(BIN, 'pixtuoid-hook.exe'), path.join(bin, 'pixtuoid-hook.exe'));
    const host = hostEnvOf(INHERITED);
    const hostPath = (process.env.PATH ?? '').split(';').filter(r.pathFilter ?? (() => true));
    const env = { ...host };
    delete env.PATH; delete env.Path;
    env.PATH = [bin, cli.binDir, path.dirname(process.execPath), ...hostPath].join(';');
    const home = at('home');
    Object.assign(env, {
      HOME: home, USERPROFILE: home, APPDATA: at('home/AppData/Roaming'), LOCALAPPDATA: at('home/AppData/Local'),
      XDG_CONFIG_HOME: at('xdg/config'), XDG_DATA_HOME: at('xdg/data'), XDG_STATE_HOME: at('xdg/state'), XDG_CACHE_HOME: at('xdg/cache'),
    });
    if (!r.noHomeEnv) env[CLIS[r.source].homeEnv] = at(`homes/${CLIS[r.source].homeEnv}`);
    Object.assign(env, r.env(port), r.extra ?? {});
    for (const c of r.config ?? []) write(path.join(env[c.home], c.path), c.body(port));
    result.pathDirs = env.PATH.split(';');

    const connect = sh(path.join(BIN, 'pixtuoid.exe'), ['connect', r.source, '--json'], { env });
    write(path.join(out, 'connect.log'), `exit ${connect.status}\n${connect.out}`);
    result.connect = connect.status;

    const ws = path.join(ROOT, 'pixtuoid-capture', 'proj');
    fs.rmSync(path.dirname(ws), { recursive: true, force: true });
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'NOTE.txt'), 'pong\n');
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: 'NUL', GIT_CONFIG_SYSTEM: 'NUL' };
    for (const a of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=fixture@pixtuoid', '-c', 'user.name=fixture', 'commit', '-qm', 'init']]) {
      const g = sh('git', ['-C', ws, ...a], { env: gitEnv });
      if (g.status !== 0) throw new Error(`git ${a.join(' ')}: ${g.out}`);
    }
    result.workspace = ws;
    result.workspaceReal = fs.realpathSync.native(ws);

    const scriptText = r.scriptBody ? JSON.stringify(r.scriptBody) : fs.readFileSync(path.join(SCRIPTS, r.script), 'utf8');
    const script = path.join(sb, 'script.json');
    fs.writeFileSync(script, scriptText.replaceAll('{workspace}', JSON.stringify(ws).slice(1, -1)));
    const aimockLog = fs.openSync(path.join(out, 'aimock.log'), 'a');
    const aimock = spawn(process.execPath, [AIMOCK, '-p', String(port), '-f', script], { env: hostEnvOf(INHERITED), stdio: ['ignore', aimockLog, aimockLog] });
    children.push(aimock);
    result.aimockBootMs = await until(() => httpGet(port, '/v1/models').then(() => true, () => false), 'aimock');

    const tag = r.id.replace(/[^a-z0-9]/gi, '-');
    const sceneName = `pixtuoid-pilot-scene-${tag}`;
    const sceneLog = fs.openSync(path.join(out, 'scene.log'), 'a');
    const scene = spawn(path.join(BIN, 'pixtuoid.exe'), ['run', '--headless', '--log-level', 'warn', '--socket', `\\\\.\\pipe\\${sceneName}`], { env: { ...env, NO_COLOR: '1' }, stdio: ['ignore', sceneLog, sceneLog] });
    children.push(scene);
    result.sceneBootMs = await until(() => pipeListed(sceneName), "the headless pixtuoid's pipe");

    const teeName = `pixtuoid-pilot-${tag}`;
    const payloads = path.join(out, 'hook-payloads.jsonl');
    const t = await tee(teeName, payloads, sceneName);

    const cliOut = fs.openSync(path.join(out, 'cli.log'), 'a');
    const started = Date.now();
    const argv = [...cli.argv, ...r.args];
    result.argv = argv;
    const child = spawn(argv[0], argv.slice(1), { cwd: ws, env: { ...env, PIXTUOID_SOCKET: `\\\\.\\pipe\\${teeName}` }, stdio: ['ignore', cliOut, cliOut] });
    children.push(child);
    const exit = await new Promise((res) => {
      const timer = setTimeout(() => { result.timedOut = true; kill(child); }, CLI_TIMEOUT_MS);
      child.on('exit', (code, signal) => { clearTimeout(timer); res({ code, signal }); });
      child.on('error', (e) => { clearTimeout(timer); res({ code: null, signal: null, error: e.message }); });
    });
    result.exit = exit;
    result.cliMs = Date.now() - started;
    // Settle on the last payload, as the recorder does.
    let prev = -1; let quiet = 0;
    for (let i = 0; i < 40 && quiet < 4; i += 1) { quiet = t.got.length === prev ? quiet + 1 : 0; prev = t.got.length; await sleep(500); }
    await t.drained();
    result.lastPayloadAfterExitMs = t.got.length ? t.got[t.got.length - 1] - (started + result.cliMs) : null;
    result.forwardErrors = t.forwardErrors;
    t.server.close();
    await sleep(4000);
    kill(scene);
    const journal = JSON.parse(await httpGet(port, '/__aimock/journal'));
    write(path.join(out, 'aimock-journal.json'), JSON.stringify(journal, null, 2));
    result.requests = journal.length;
    result.unmatched = journal.filter((e) => e.response?.fixture == null).length;
    result.events = eventsOf(payloads);
    const frames = fs.readFileSync(path.join(out, 'scene.log'), 'utf8').split('\n').filter((l) => l.startsWith('agents='));
    result.sceneFrames = [...new Set(frames)].slice(0, 12);
  } catch (e) {
    result.error = e.stack ?? String(e);
  } finally {
    for (const c of children) kill(c);
    copySmallTree(sb, path.join(out, 'sandbox'));
    write(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  }
  return result;
}

// Files the runs wrote under the runner's own profile: a home a CLI resolved
// past the sandbox's USERPROFILE.
function leaks(since) {
  const home = process.env.USERPROFILE;
  const skip = [/\\AppData\\Local\\Temp/i, /\\npm-cache/i, /\\AppData\\Roaming\\npm/i, /\\\.cargo/i, /\\\.rustup/i, /\\AppData\\Local\\Microsoft/i, /\\AppData\\Local\\Packages/i];
  const found = [];
  const walk = (d, depth) => {
    if (depth > 6 || found.length > 500 || skip.some((s) => s.test(d))) return;
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      let st; try { st = fs.lstatSync(p); } catch { continue; }
      if (st.mtimeMs >= since || st.birthtimeMs >= since) found.push(`${e.isDirectory() ? 'd' : 'f'} ${p}`);
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p, depth + 1);
    }
  };
  walk(home, 0);
  write(path.join(OUT, 'leaks.txt'), `${found.join('\n')}\n`);
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  facts();
  const runs = RUNS.map(resolveRun).filter((r) => !only || only.test(r.id));
  const clis = {};
  for (const s of new Set(runs.map((r) => r.source))) {
    try { clis[s] = install(s); } catch (e) { clis[s] = { error: e.stack }; }
  }
  const since = Date.now();
  const summary = [];
  for (const r of runs) {
    say('==', r.id);
    const cli = clis[r.source];
    const res = cli.error ? { id: r.id, error: `install: ${cli.error}` } : await runOne(r, cli);
    say(JSON.stringify({ id: res.id, exit: res.exit, ms: res.cliMs, requests: res.requests, unmatched: res.unmatched, events: res.events, frames: res.sceneFrames, error: res.error?.split('\n')[0] }));
    summary.push(res);
  }
  leaks(since);
  write(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
}

await main();
