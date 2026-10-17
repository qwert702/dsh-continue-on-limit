window.__ModuleLoader__.load({
	id: "dsh-continue-on-limit",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		//#region dsh-continue-on-limit/config.js
		/**
		 * Default configuration, mirrored from the host half. Used until the
		 * config route answers, so a slow or missing host never stalls the
		 * auto-continue.
		 */
		const CONFIG_DEFAULTS = Object.freeze({
			enabled: true,
			continueText: "继续",
			maxConsecutive: 3,
			minIntervalMs: 1500,
		});

		/**
		 * Resolve the plugin configuration from the host route, merged over the
		 * defaults so an older host (or a config object that gained fields)
		 * still yields a complete object. Any failure falls back to the defaults —
		 * a config fetch hiccup must never block auto-continue.
		 * @returns the resolved configuration object.
		 */
		async function loadConfig() {
			try {
				const response = await fetch("/api/dsh-continue-on-limit/config", { method: "GET" });
				if (!response.ok) throw new Error("config route responded " + response.status);
				const data = await response.json();
				const section = data?.ok === true && data.config !== null && typeof data.config === "object" ? data.config : null;
				if (section === null) throw new Error("config route payload is not an object");
				const config = { ...CONFIG_DEFAULTS, ...section };
				if (typeof config.continueText !== "string" || config.continueText.trim() === "") config.continueText = CONFIG_DEFAULTS.continueText;
				return config;
			} catch (error) {
				console.warn("[dsh-continue-on-limit] 读取配置失败，使用默认配置：", error instanceof Error ? error.message : error);
				return { ...CONFIG_DEFAULTS };
			}
		}
		//#endregion

		//#region dsh-continue-on-limit/projection.js
		/**
		 * Key of the host-side projection published by lib/index.js. The 0.2.0
		 * client contract hands a header-action seat the Session snapshot and the
		 * keyed `useProjection` hook, but not the Chat snapshot, so the notice is
		 * folded host-side and read back here.
		 */
		const PROJECTION_KEY = "continueMaxTokens";

		/**
		 * Whether a retirement record belongs to a human message that is NOT the
		 * auto-continue text we sent ourselves (the chain must start over then).
		 * @param retired - the projection's retirement record.
		 * @param continueText - the configured resume text.
		 * @returns true when the human took the conversation over.
		 */
		function isForeignHumanMessage(retired, continueText) {
			if (retired === null || retired === undefined) return false;
			if (retired.kind !== "user" && retired.kind !== "steering") return false;
			if (typeof retired.text !== "string") return false;
			const sent = typeof continueText === "string" ? continueText.trim() : "";
			return retired.text.trim() !== sent;
		}

		/**
		 * Decide whether to auto-continue for one snapshot.
		 * @param snapshot - the Session snapshot (removed / openState / running / pendingSubmissions).
		 * @param projection - the `continueMaxTokens` projection value, when published.
		 * @param state - per-session { lastNoticeSeq, consecutive, lastSentAt }.
		 * @param config - resolved plugin configuration.
		 * @param now - epoch ms timestamp for the cooldown check.
		 * @returns one of: disabled / removed / not-open / running / queued /
		 *   no-notice / handled / cooldown / cap / send { notice }.
		 */
		function evaluate(snapshot, projection, state, config, now) {
			if (config.enabled !== true) return { action: "disabled" };
			if (snapshot.removed) return { action: "removed" };
			if (snapshot.openState !== "open") return { action: "not-open" };
			if (snapshot.running) return { action: "running" };
			if ((snapshot.pendingSubmissions ?? []).length > 0) return { action: "queued" };
			const notice = projection?.notice ?? null;
			if (notice === null) return { action: "no-notice" };
			if (notice.seq === state.lastNoticeSeq) return { action: "handled" };
			if (now - state.lastSentAt < config.minIntervalMs) return { action: "cooldown" };
			if (state.consecutive >= config.maxConsecutive) return { action: "cap", notice };
			return { action: "send", notice };
		}

		/**
		 * Whether the chain counter should reset. The host retirement record is
		 * newer than the handled notice and says the flow moved on without a
		 * further truncation: a normally closed turn (the model finished) or a
		 * human message that was not our auto-continue.
		 * @param projection - the `continueMaxTokens` projection value.
		 * @param state - per-session { lastNoticeSeq, consecutive }.
		 * @param config - resolved plugin configuration.
		 * @returns true when the consecutive chain must start over.
		 */
		function evaluateReset(projection, state, config) {
			const retired = projection?.retired ?? null;
			if (retired === null) return false;
			if (typeof retired.seq !== "number" || retired.seq <= state.lastNoticeSeq) return false;
			if (retired.kind === "turn-end") return true;
			return isForeignHumanMessage(retired, config.continueText);
		}
		//#endregion

		//#region dsh-continue-on-limit/AutoContinue.js
		/**
		 * The invisible observer. Rides the session-scoped
		 * `conversation.session.header.actions` seat and renders nothing; its job
		 * is to subscribe the staged session's snapshot and the host projection,
		 * and, when a fresh output-cap notice lands at the tail of an idle
		 * conversation, send the configured continue text through the session
		 * face's `prompt` verb.
		 *
		 * Guardrails, all enforced by the pure `evaluate` policy: the truncation
		 * must be the tail of the session log (enforced by the host fold), the
		 * session must be idle with no pending submission, the same notice is
		 * handled at most once, a cooldown spaces consecutive sends, and a burst
		 * cap stops the chain when the model keeps hitting the cap without ever
		 * completing a turn. A human message or a normally completed turn resets
		 * the chain counter.
		 * @param props.useSession - session-scope snapshot selector (standard prop).
		 * @param props.useProjection - keyed projection selector (standard prop).
		 * @param props.sessionId - the staged Session id (standard prop).
		 * @param props.sessions - the client sessions runtime (captured in apply).
		 */
		const AutoContinue = react.memo(function AutoContinue({ useSession, useProjection, sessionId, sessions }) {
			const snapshot = useSession((s) => s);
			const projection = typeof useProjection === "function" ? useProjection(PROJECTION_KEY) : undefined;
			const currentId = snapshot?.sessionId ?? sessionId;
			const stateRef = react.useRef({ config: CONFIG_DEFAULTS, lastNoticeSeq: -1, consecutive: 0, lastSentAt: 0 });

			// Resolve the host configuration once per session (a reload re-reads it).
			react.useEffect(() => {
				let alive = true;
				loadConfig().then((config) => {
					if (alive) stateRef.current.config = config;
				});
				return () => {
					alive = false;
				};
			}, [currentId]);

			// Fresh session identity: start a clean chain.
			react.useEffect(() => {
				stateRef.current = { ...stateRef.current, lastNoticeSeq: -1, consecutive: 0, lastSentAt: 0 };
			}, [currentId]);

			// Mount diagnostic: makes a silent failure loud. If this line never
			// appears, the client half did not load (install/bundle issue); a
			// missing projection means the host half did not register its unit.
			react.useEffect(() => {
				const notice = projection?.notice ?? null;
				console.info("[dsh-continue-on-limit] 观察器已挂载：projection=" + (projection === undefined ? "缺失" : notice === null ? "就绪(无截断)" : "截断 turn " + notice.turn));
			}, [currentId, projection]);

			// The auto-continue effect: runs on every snapshot/projection change,
			// idempotent via evaluate.
			react.useEffect(() => {
				const state = stateRef.current;
				const config = state.config;
				const verdict = evaluate(snapshot, projection, state, config, Date.now());
				if (verdict.action === "cap") {
					state.lastNoticeSeq = verdict.notice.seq;
					console.warn("[dsh-continue-on-limit] 连续自动继续已达上限（" + config.maxConsecutive + " 次），请手动发送「" + config.continueText + "」继续");
					return;
				}
				if (verdict.action !== "send") return;
				const session = sessions.binding(currentId)?.session;
				if (session === undefined) {
					console.warn("[dsh-continue-on-limit] 会话绑定不可用，等待下一次快照变化");
					return;
				}
				const text = config.continueText;
				state.lastSentAt = Date.now();
				state.consecutive += 1;
				console.info("[dsh-continue-on-limit] 检测到输出达到上限（turn " + verdict.notice.turn + "），自动发送「" + text + "」");
				session.prompt([{ type: "text", text }], "queue").then((result) => {
					if (!result.ok) throw new Error(String(result.error?.message ?? result.error?.code ?? "prompt rejected"));
					state.lastNoticeSeq = verdict.notice.seq;
				}).catch((error) => {
					// The notice stays unhandled; the cooldown gates a retry on the
					// next snapshot change. A persistent failure hits the burst cap.
					console.warn("[dsh-continue-on-limit] 自动发送「" + text + "」失败：", error instanceof Error ? error.message : error);
				});
			}, [snapshot, projection, currentId, sessions]);

			// The chain-reset effect: human input or a normally completed turn starts over.
			react.useEffect(() => {
				const state = stateRef.current;
				if (state.consecutive === 0) return;
				if (evaluateReset(projection, state, state.config)) {
					state.consecutive = 0;
					console.info("[dsh-continue-on-limit] 检测到用户新消息或模型已正常完成回复，重置自动继续计数");
				}
			}, [projection]);

			return null;
		});
		//#endregion

		//#region dsh-continue-on-limit/index.js
		/**
		 * Client plugin body: one additive entry on the
		 * `conversation.session.header.actions` list seat (session scope) — the
		 * same seat the context-compressor rides. The entry renders nothing; it
		 * exists to subscribe the auto-continue policy to the staged session's
		 * snapshot and the host notice projection. Nothing in the stock
		 * composition is replaced or disabled.
		 * @param ctx - client root context.
		 */
		const inject = ["slots", "sessions"];
		function apply(ctx) {
			const sessions = ctx.get("sessions");
			const AutoContinueEntry = (props) => react_jsx_runtime.jsx(AutoContinue, {
				...props,
				sessions,
			});
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "continue-on-limit",
				priority: 10,
			}, AutoContinueEntry));
		}
		//#endregion
		exports.CONFIG_DEFAULTS = CONFIG_DEFAULTS;
		exports.PROJECTION_KEY = PROJECTION_KEY;
		exports.isForeignHumanMessage = isForeignHumanMessage;
		exports.loadConfig = loadConfig;
		exports.evaluate = evaluate;
		exports.evaluateReset = evaluateReset;
		exports.AutoContinue = AutoContinue;
		exports.apply = apply;
		exports.inject = inject;
	return module.exports;
	}
});
