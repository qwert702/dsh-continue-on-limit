// Smoke test for dsh-continue-on-limit (harness 0.2.0 config + projection era):
// 1. node --check on lib/index.js + lib/client.js
// 2. Host half: exports name/inject/Config (the loader config channel); apply()
//    registers the `continueMaxTokens` session projection and the
//    GET /api/dsh-continue-on-limit/config route; the projection fold arms the
//    notice on a max-tokens turn/end and retires it on every later flow event;
//    the route returns the composition defaults or the apply() config and
//    rejects non-GET verbs.
// 3. Client bundle: the additive header.actions registration (and nothing else),
//    the pure evaluate() policy across every branch, the chain-reset policy,
//    loadConfig against a mocked fetch, and the SSR null render.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const pkg = path.resolve(__dirname, '..');
const bundle = path.join(pkg, 'lib/client.js');
const hostFile = path.join(pkg, 'lib/index.js');

// The host half imports harness packages. When this checkout has no
// node_modules (fresh clone), junction the harness install's node_modules
// from $DSH_HARNESS_NODE_MODULES so the smoke test still runs against a real
// install.
const localNodeModules = path.join(pkg, 'node_modules');
const harnessModules = process.env.DSH_HARNESS_NODE_MODULES ?? 'C:/Users/cbn/.dsh/profiles/node_modules';
if (!fs.existsSync(localNodeModules) && fs.existsSync(harnessModules)) {
  fs.symlinkSync(harnessModules, localNodeModules, 'junction');
}

// --- 1. syntax ---
execFileSync(process.execPath, ['--check', bundle], { stdio: 'inherit' });
execFileSync(process.execPath, ['--check', hostFile], { stdio: 'inherit' });
console.log('OK: node --check passed (client.js + index.js)');

// --- 2. host half: Config export, projection fold, config route ---
async function hostTests() {
  const host = await import('file:///' + hostFile.replace(/\\/g, '/'));
  if (host.name !== 'dsh-continue-on-limit-host') throw new Error('bad host name: ' + host.name);
  for (const service of ['webServer', 'sessionProjections']) {
    if (!host.inject.includes(service)) throw new Error('host missing inject: ' + service);
  }
  if (host.inject.includes('settings')) throw new Error('host must not inject the removed settings service');
  if (typeof host.Config?.['~standard']?.validate !== 'function') throw new Error('Config is not a Standard Schema');
  console.log('OK: host exports name/inject/Config (loader config channel)');

  const registeredRoutes = [];
  const projections = [];
  const ctx = {
    effect(fn) { fn(); },
    inject(services, cb) {
      if (!services.includes('sessionProjections')) throw new Error('unexpected inject: ' + JSON.stringify(services));
      cb({
        sessionProjections: {
          register(definition) { projections.push(definition); return () => {}; },
        },
      });
    },
    webServer: {
      register(route) { registeredRoutes.push(route); return () => {}; },
    },
  };

  // bare mount -> composition defaults
  host.apply(ctx);
  const route = registeredRoutes.find((r) => r.path === '/api/dsh-continue-on-limit/config');
  if (route === undefined) throw new Error('config route not registered');
  if (route.kind !== 'exact') throw new Error('wrong route kind: ' + JSON.stringify(route));

  const definition = projections[0];
  if (definition === undefined) throw new Error('continueMaxTokens projection not registered');
  if (definition.key !== 'continueMaxTokens') throw new Error('wrong projection key: ' + definition.key);
  if (typeof definition.init !== 'function' || typeof definition.apply !== 'function') throw new Error('projection unit functions missing');
  if (definition.wire === undefined || typeof definition.wire.view !== 'function') throw new Error('projection wire view missing');
  const empty = definition.init();
  if (empty.notice !== null || empty.retired !== null) throw new Error('projection init wrong: ' + JSON.stringify(empty));
  console.log('OK: host registers the continueMaxTokens projection unit');

  /** Fold a fresh state through a list of events. */
  const fold = (events) => events.reduce((state, event) => definition.apply(state, event), definition.init());
  const maxTokensEnd = { type: 'turn/end', seq: 10, time: 100, data: { turn: 2, reason: { kind: 'max-tokens' } } };
  const normalEnd = { type: 'turn/end', seq: 40, time: 400, data: { turn: 3, reason: { kind: 'completed' } } };
  const humanMsg = { type: 'user/message', seq: 30, time: 300, data: { role: 'user', content: [{ type: 'text', text: '换个问题' }], source: {} } };
  const turnStart = { type: 'turn/start', seq: 20, time: 200, data: { turn: 3 } };
  const irrelevant = { type: 'assistant/message', seq: 9, time: 90, data: { turn: 2, step: 1 } };

  let state = fold([maxTokensEnd]);
  if (state.notice === null || state.notice.seq !== 10 || state.notice.turn !== 2) throw new Error('max-tokens turn/end must arm the notice: ' + JSON.stringify(state));
  if (state.retired !== null) throw new Error('a fresh notice must not carry a retirement');
  const armed = state;
  if (definition.apply(armed, irrelevant) !== armed) throw new Error('uninterested events must keep the state reference');
  state = fold([maxTokensEnd, turnStart]);
  if (state.notice !== null || state.retired?.kind !== 'turn-start' || state.retired.seq !== 20) throw new Error('turn/start must retire the notice: ' + JSON.stringify(state));
  state = fold([maxTokensEnd, humanMsg]);
  if (state.notice !== null || state.retired?.kind !== 'user' || state.retired.text !== '换个问题') throw new Error('user message must retire the notice with its text: ' + JSON.stringify(state));
  state = fold([maxTokensEnd, normalEnd]);
  if (state.notice !== null || state.retired?.kind !== 'turn-end') throw new Error('a normal turn/end must retire the notice: ' + JSON.stringify(state));
  const wired = definition.wire.view(armed);
  if (wired !== armed) throw new Error('wire view must publish the state object itself');
  if (definition.wire.viewSchema['~standard'].validate(wired).issues !== undefined) throw new Error('wire viewSchema rejected the armed state');
  console.log('OK: projection fold arms and retires the output-cap notice');

  function fakeRes() {
    let status = 0;
    let body = '';
    return {
      res: {
        writeHead(s) { status = s; },
        end(b) { body = b; },
      },
      status: () => status,
      body: () => body,
    };
  }

  let f = fakeRes();
  await route.handler({ method: 'GET' }, f.res);
  let parsed = JSON.parse(f.body());
  if (f.status() !== 200 || parsed.ok !== true) throw new Error('defaults path wrong: ' + f.status() + ' ' + f.body());
  if (parsed.config.enabled !== true || parsed.config.continueText !== '继续' || parsed.config.maxConsecutive !== 3 || parsed.config.minIntervalMs !== 1500) {
    throw new Error('defaults wrong: ' + JSON.stringify(parsed.config));
  }
  console.log('OK: host route returns composition defaults');

  // apply(config) -> overrides from the profile entry
  const configuredRoutes = [];
  const configuredCtx = {
    effect(fn) { fn(); },
    inject(services, cb) { cb({ sessionProjections: { register() { return () => {}; } } }); },
    webServer: { register(r) { configuredRoutes.push(r); return () => {}; } },
  };
  host.apply(configuredCtx, { enabled: false, continueText: '请继续', maxConsecutive: 5, minIntervalMs: 800 });
  const configuredRoute = configuredRoutes.find((r) => r.path === '/api/dsh-continue-on-limit/config');
  f = fakeRes();
  await configuredRoute.handler({ method: 'GET' }, f.res);
  parsed = JSON.parse(f.body());
  if (parsed.config.enabled !== false || parsed.config.continueText !== '请继续' || parsed.config.maxConsecutive !== 5 || parsed.config.minIntervalMs !== 800) {
    throw new Error('overrides wrong: ' + JSON.stringify(parsed.config));
  }
  console.log('OK: host route returns the apply() config overrides');

  f = fakeRes();
  await route.handler({ method: 'POST' }, f.res);
  parsed = JSON.parse(f.body());
  if (f.status() !== 405 || parsed.ok !== false || parsed.error.code !== 'method-not-allowed') {
    throw new Error('method-not-allowed path wrong: ' + f.status() + ' ' + f.body());
  }
  console.log('OK: host route rejects non-GET');
}

// --- 3. client bundle tests ---
async function clientTests() {
  const react = require(path.join(harnessModules, 'react'));
  const jsxRuntime = require(path.join(harnessModules, 'react/jsx-runtime'));

  const loader = {};
  global.window = {
    __ModuleLoader__: {
      load(entry) {
        loader.id = entry.id;
        loader.exports = entry.factory((spec) => {
          if (spec === 'react') return react;
          if (spec === 'react/jsx-runtime') return jsxRuntime;
          throw new Error('unexpected require: ' + spec);
        });
      },
    },
  };
  try {
    const source = fs.readFileSync(bundle, 'utf8');
    (0, eval)(source);
  } finally {
    delete global.window;
  }
  if (loader.id !== 'dsh-continue-on-limit') throw new Error('wrong bundle id: ' + loader.id);
  const client = loader.exports;
  if (client.inject.length !== 2 || client.inject[0] !== 'slots' || client.inject[1] !== 'sessions') {
    throw new Error('wrong client inject: ' + JSON.stringify(client.inject));
  }
  console.log('OK: client bundle loads, inject slots+sessions');

  // registration: exactly one additive header.actions entry, no chat-node seat
  const seats = [];
  const entries = [];
  const sessionsMock = {
    list: { getSnapshot: () => ({ ids: ['session-1'], byId: {} }) },
    binding: () => undefined,
  };
  const ctx = {
    get: (name) => (name === 'sessions' ? sessionsMock : undefined),
    slots: {
      inject(key, factory) {
        seats.push(key);
        factory();
        return () => {};
      },
      register(opts, component) {
        entries.push({ opts, component });
        return () => {};
      },
    },
  };
  client.apply(ctx);
  if (seats.length !== 1 || seats[0] !== 'conversation.session.header.actions') {
    throw new Error('wrong injected seats: ' + JSON.stringify(seats));
  }
  const action = entries.find((e) => e.opts.name === 'conversation.session.header.actions');
  if (action === undefined) throw new Error('header.actions entry not registered');
  if (action.opts.id !== 'continue-on-limit' || action.opts.priority !== 10) throw new Error('wrong header action opts: ' + JSON.stringify(action.opts));
  console.log('OK: client registers the invisible header.actions entry only');

  // --- evaluate() policy branches ---
  const config = { enabled: true, continueText: '继续', maxConsecutive: 3, minIntervalMs: 1500 };
  const notice = { turn: 2, seq: 100.05, time: 1 };
  const projection = { notice, retired: null };
  const baseSnapshot = {
    sessionId: 'session-1',
    pendingSubmissions: [],
    running: false,
    removed: false,
    openState: 'open',
  };
  const freshState = () => ({ lastNoticeSeq: -1, consecutive: 0, lastSentAt: 0 });

  let verdict = client.evaluate(baseSnapshot, projection, freshState(), { ...config, enabled: false }, 1000);
  if (verdict.action !== 'disabled') throw new Error('disabled branch: ' + JSON.stringify(verdict));
  verdict = client.evaluate({ ...baseSnapshot, removed: true }, projection, freshState(), config, 1000);
  if (verdict.action !== 'removed') throw new Error('removed branch: ' + JSON.stringify(verdict));
  verdict = client.evaluate({ ...baseSnapshot, openState: 'loading' }, projection, freshState(), config, 1000);
  if (verdict.action !== 'not-open') throw new Error('not-open branch: ' + JSON.stringify(verdict));
  verdict = client.evaluate({ ...baseSnapshot, running: true }, projection, freshState(), config, 1000);
  if (verdict.action !== 'running') throw new Error('running branch: ' + JSON.stringify(verdict));
  verdict = client.evaluate({ ...baseSnapshot, pendingSubmissions: [{ requestId: 'r-1' }] }, projection, freshState(), config, 1000);
  if (verdict.action !== 'queued') throw new Error('queued branch: ' + JSON.stringify(verdict));
  verdict = client.evaluate(baseSnapshot, { notice: null, retired: { seq: 120, kind: 'user', text: '我自己来' } }, freshState(), config, 1000);
  if (verdict.action !== 'no-notice') throw new Error('no-notice branch: ' + JSON.stringify(verdict));
  verdict = client.evaluate(baseSnapshot, undefined, freshState(), config, 1000);
  if (verdict.action !== 'no-notice') throw new Error('missing projection must be a no-notice branch: ' + JSON.stringify(verdict));
  verdict = client.evaluate(baseSnapshot, projection, { lastNoticeSeq: 100.05, consecutive: 1, lastSentAt: 0 }, config, 1000);
  if (verdict.action !== 'handled') throw new Error('handled branch: ' + JSON.stringify(verdict));
  verdict = client.evaluate(baseSnapshot, projection, { lastNoticeSeq: -1, consecutive: 1, lastSentAt: 9900 }, config, 10000);
  if (verdict.action !== 'cooldown') throw new Error('cooldown branch: ' + JSON.stringify(verdict));
  verdict = client.evaluate(baseSnapshot, projection, { lastNoticeSeq: -1, consecutive: 3, lastSentAt: 0 }, config, 10000);
  if (verdict.action !== 'cap' || verdict.notice !== notice) throw new Error('cap branch: ' + JSON.stringify(verdict));
  verdict = client.evaluate(baseSnapshot, projection, freshState(), config, 10000);
  if (verdict.action !== 'send' || verdict.notice !== notice) throw new Error('send branch: ' + JSON.stringify(verdict));
  console.log('OK: evaluate() covers every branch');

  // --- evaluateReset() ---
  if (client.evaluateReset({ notice: null, retired: null }, { lastNoticeSeq: 100.05, consecutive: 1 }, config)) {
    throw new Error('no retirement must not reset the chain');
  }
  if (client.evaluateReset({ notice: null, retired: { seq: 90, kind: 'turn-end', text: null } }, { lastNoticeSeq: 100.05, consecutive: 1 }, config)) {
    throw new Error('a retirement older than the handled notice must not reset');
  }
  if (!client.evaluateReset({ notice: null, retired: { seq: 130, kind: 'turn-end', text: null } }, { lastNoticeSeq: 100.05, consecutive: 1 }, config)) {
    throw new Error('a normally closed turn must reset the chain');
  }
  if (!client.evaluateReset({ notice: null, retired: { seq: 130, kind: 'user', text: '换个问题' } }, { lastNoticeSeq: 100.05, consecutive: 1 }, config)) {
    throw new Error('a foreign human message must reset the chain');
  }
  if (client.evaluateReset({ notice: null, retired: { seq: 130, kind: 'user', text: '继续' } }, { lastNoticeSeq: 100.05, consecutive: 1 }, config)) {
    throw new Error('our own auto-continue must not reset the chain');
  }
  if (!client.evaluateReset({ notice: null, retired: { seq: 130, kind: 'steering', text: '停一下' } }, { lastNoticeSeq: 100.05, consecutive: 1 }, config)) {
    throw new Error('a human steering message must reset the chain');
  }
  if (client.evaluateReset({ notice: null, retired: { seq: 130, kind: 'turn-start', text: null } }, { lastNoticeSeq: 100.05, consecutive: 1 }, config)) {
    throw new Error('our own continue starting the next turn must not reset the chain');
  }
  console.log('OK: evaluateReset() covers the chain-reset branches');

  // --- loadConfig() against a mocked fetch ---
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, config: { enabled: false, continueText: '请继续', maxConsecutive: 5, minIntervalMs: 800 } }) });
    const configured = await client.loadConfig();
    if (configured.enabled !== false || configured.continueText !== '请继续' || configured.maxConsecutive !== 5 || configured.minIntervalMs !== 800) {
      throw new Error('loadConfig configured wrong: ' + JSON.stringify(configured));
    }
    console.log('OK: loadConfig merges the host section');

    global.fetch = async () => { throw new Error('network down'); };
    const fallenBack = await client.loadConfig();
    if (fallenBack.enabled !== true || fallenBack.continueText !== '继续' || fallenBack.maxConsecutive !== 3) {
      throw new Error('loadConfig fallback wrong: ' + JSON.stringify(fallenBack));
    }
    console.log('OK: loadConfig falls back to defaults on failure');

    global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, config: { continueText: '' } }) });
    const normalized = await client.loadConfig();
    if (normalized.continueText !== '继续') throw new Error('loadConfig empty continueText not normalized: ' + JSON.stringify(normalized));
    console.log('OK: loadConfig normalizes an empty continueText');
  } finally {
    global.fetch = originalFetch;
  }

  // --- SSR: the observer renders nothing ---
  const renderer = require(path.join(harnessModules, 'react-dom/server'));
  const html = renderer.renderToString(react.createElement(client.AutoContinue, {
    useSession: (sel) => sel(baseSnapshot),
    useProjection: () => projection,
    sessionId: 'session-1',
    sessions: sessionsMock,
  }));
  if (html !== '') throw new Error('observer must render nothing, got: ' + html);
  console.log('OK: client SSR renders nothing (invisible observer)');
}

async function main() {
  await hostTests();
  await clientTests();
  console.log('all smoke tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
