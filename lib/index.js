//#region lib/index.js
/**
 * Continue-on-limit plugin, node half.
 *
 * Owns three things:
 *
 *  - the plugin configuration: the `Config` export validated by the loader and
 *    handed to `apply(ctx, config)` — the 0.1.7+/0.2.0 config channel that
 *    replaced the removed `settings.register()` namespace;
 *  - the read route the browser half consumes:
 *    `GET /api/dsh-continue-on-limit/config`;
 *  - the `continueMaxTokens` session projection: a host-side fold of the
 *    session log that publishes the latest output-cap notice together with the
 *    event that retired it. The browser half reads it through `useProjection`,
 *    because a 0.2.0 header-action seat receives the Session snapshot and the
 *    projection map but no Chat snapshot (the old client-side chat-node walk
 *    and the `conversationEvents` definition registry no longer exist).
 *
 * The fold keeps the "truncation must be the tail of the flow" rule host-side:
 * any later `turn/start`, `user/message`, `steering/message`, or normally
 * closed `turn/end` clears the notice and records that retirement.
 */
import z from '@deepseek-ai/schemastery'
import { z as zWire } from 'zod'

/** Cordis plugin name for the host half. */
const name = 'dsh-continue-on-limit-host'
/** Services required by the config route and the notice projection. */
const inject = ['webServer', 'sessionProjections']

/** Projection key carrying the output-cap notice to the browser half. */
const PROJECTION_KEY = 'continueMaxTokens'

/**
 * Schema: the feature switch, the exact text sent to resume the reply, the
 * maximum number of back-to-back auto-continues without the model completing
 * a turn (burst protection — a model that always hits the cap cannot drain
 * tokens forever), and the minimum gap between two auto-sends.
 */
const SCHEMA = z.object({
  enabled: z.boolean().default(true),
  continueText: z.string().default('继续'),
  maxConsecutive: z.number().default(3),
  minIntervalMs: z.number().default(1500),
})

/**
 * The plugin's config schema, read from the profile entry by the loader and
 * handed to `apply(ctx, config)` (the 0.1.7+/0.2.0 config channel).
 */
const Config = SCHEMA

/** Composition defaults when the profile entry carries no config. */
const DEFAULT_LIMITS = {
  enabled: true,
  continueText: '继续',
  maxConsecutive: 3,
  minIntervalMs: 1500,
}

/** One output-cap notice as published to the browser half. */
const noticeSchema = zWire.object({
  turn: zWire.number().int().nonnegative(),
  seq: zWire.number().nonnegative(),
  time: zWire.number().nonnegative(),
}).strict()

/** The event that retired a notice, with the text when it was a human message. */
const retiredSchema = zWire.object({
  seq: zWire.number().nonnegative(),
  kind: zWire.string(),
  text: zWire.string().nullable(),
}).strict()

/** Projection state: the live notice, and the event that retired the last one. */
const stateSchema = zWire.object({
  notice: noticeSchema.nullable(),
  retired: retiredSchema.nullable(),
}).strict()

/** Empty state used before the first interesting event. */
function emptyState() {
  return { notice: null, retired: null }
}

/**
 * Join the text blocks of a `user/message` / `steering/message` payload.
 * @param data - the session event payload.
 * @returns the joined text (empty when the payload carries none).
 */
function messageText(data) {
  const content = data?.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    if (part !== null && typeof part === 'object' && typeof part.text === 'string') text += part.text
  }
  return text
}

/**
 * Fold one committed event into the notice state. A `turn/end` with the
 * `max-tokens` reason arms the notice; every later flow event retires it, so
 * the published notice is always the tail of the session log.
 * @param state - the state covering all prior events.
 * @param event - one committed session event.
 * @returns the next state (the same reference for uninterested events).
 */
function projectEvent(state, event) {
  const type = event?.type
  if (type === 'turn/end') {
    if (event.data?.reason?.kind === 'max-tokens') {
      return { notice: { turn: event.data.turn, seq: event.seq, time: event.time }, retired: null }
    }
    return { notice: null, retired: { seq: event.seq, kind: 'turn-end', text: null } }
  }
  if (type === 'user/message' || type === 'steering/message') {
    return {
      notice: null,
      retired: { seq: event.seq, kind: type === 'user/message' ? 'user' : 'steering', text: messageText(event.data) },
    }
  }
  if (type === 'turn/start') {
    return { notice: null, retired: { seq: event.seq, kind: 'turn-start', text: null } }
  }
  return state
}

/**
 * Register the output-cap projection. The unit declares a `wire` view, which
 * is what makes it readable as `projectionValues` in the browser.
 * @param ctx - host context carrying the sessionProjections service.
 */
function installProjection(ctx) {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register({
      key: PROJECTION_KEY,
      stateSchema,
      stateVersion: 1,
      init: emptyState,
      apply: projectEvent,
      wire: {
        viewSchema: stateSchema,
        view: (state) => state,
      },
    })
  })
}

/**
 * Write a JSON response the handler fully owns.
 * @param res - the response.
 * @param status - HTTP status.
 * @param payload - JSON-serializable payload.
 */
function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/**
 * Handle `GET /api/dsh-continue-on-limit/config`. Returns the resolved
 * configuration; any transport failure is the client's problem (it falls back
 * to its own defaults). Non-GET verbs are rejected.
 * @param req - the incoming request.
 * @param res - the response.
 * @param source - config resolver for the auto-continue configuration.
 */
async function handleConfig(req, res, source) {
  if (req.method !== 'GET') {
    send(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'this route only serves GET' } })
    return
  }
  send(res, 200, { ok: true, config: source() })
}

/**
 * Register the notice projection and the config route.
 * @param ctx - host context carrying the webServer and sessionProjections services.
 * @param config - the profile entry's validated config (absent when mounted bare).
 */
function apply(ctx, config) {
  installProjection(ctx)
  const resolved = { ...DEFAULT_LIMITS }
  if (config !== null && typeof config === 'object') {
    for (const key of Object.keys(DEFAULT_LIMITS)) {
      if (config[key] !== undefined) resolved[key] = config[key]
    }
  }
  const source = () => resolved
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-continue-on-limit/config',
      handler: (req, res) => handleConfig(req, res, source),
    }),
    'dsh-continue-on-limit: config route',
  )
}
//#endregion
export { Config, DEFAULT_LIMITS, PROJECTION_KEY, apply, inject, name, projectEvent }
