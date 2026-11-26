window.__ModuleLoader__.load({
	id: "dsh-next-reply",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");

		/** Seat: immediately before a completed Turn's action row. */
		const SLOT = "conversation.chat.turnTail";
		/** A fresh cell id, so this entry sits beside the shipped ones. */
		const CELL_ID = "next-reply";
		/** After AgentTeams' summary (50), before the action row. */
		const CELL_ORDER = 60;
		/** Hoc seat wrapping one Markdown fence, dispatched by its language. */
		const FENCE_SLOT = "conversation.chat.markdown.fence";

		/** Settings page holding the click-behaviour preference. */
		const SETTINGS_SLOT = "settings.section";
		const SETTINGS_ID = "next-reply";
		const SETTINGS_ORDER = 55;

		/** The Host half's routes. */
		const CONFIG_URL = "/plugins/dsh-next-reply/config";
		const DIAG_URL = "/plugins/dsh-next-reply/diag";

		/** The Host half's marker, matched on the raw settled text.
		 *  Two accepted shapes: the legacy HTML comment, and a `suggest` fenced
		 *  block (preferred — a hoc layer hides the block entirely). */
		const COMMENT_MARKER = /<!--\s*NEXT:\s*([\s\S]*?)-->/;
		const FENCE_MARKER = /```suggest[ \t]*\r?\n([\s\S]*?)```/;
		/** Language key of the fenced block the host instruction asks for. */
		const FENCE_KEY = "suggest";
		const MAX_CHIPS = 3;
		/** Longest pill text kept: CSS ellipsis handles display, this bounds the data. */
		const MAX_CHIP_CHARS = 80;
		/** Per-label guard so one double click cannot send the same line twice. */
		const CLICK_COOLDOWN_MS = 900;
		/** Misses already reported this page; bounded so a long session cannot leak. */
		const reported = new Set();
		const REPORTED_LIMIT = 64;

		const TOKEN = {
			text: "var(--dsw-alias-label-secondary)",
			textStrong: "var(--dsw-alias-label-primary)",
			border: "var(--dsw-alias-border-l1)",
			surface: "var(--dsw-alias-bg-layer-1)",
			accent: "var(--dsw-alias-brand-primary)"
		};

		/** Whole-snapshot selector, shared so hooks keep a stable identity. */
		const ALL = (snapshot) => snapshot;

		/** One report per label, remembered only while the page lives. */
		let lastPick = { text: "", at: 0 };

		// ---------------------------------------------------------------- store

		/**
		 * One shared preference for both seats. `directSend: true` sends on click;
		 * `false` only fills the composer. `ready` gates nothing visually — the
		 * default (send) is also the Host default, so a slow or failed fetch
		 * degrades to the documented default rather than to an inert UI.
		 */
		const store = { directSend: true, ready: false };
		const listeners = new Set();
		let inflight = null;
		let loadedAt = 0;
		/** Re-read window, short enough to notice an external change, long enough
		 *  to keep one fetch per burst of mounting chip rows. */
		const LOAD_TTL_MS = 3000;
		/** Opt-in shape report for debugging, off by default so a reply that merely
		 *  forgot its marker never leaves a grey line in the transcript. Turn it on
		 *  from the browser console with `window.__NR_DIAG__ = true` and reload. */
		const DIAG_ON = typeof window !== "undefined" && window.__NR_DIAG__ === true;

		/**
		 * Notify every subscribed seat.
		 */
		function publish() {
			for (const listener of listeners) {
				try {
					listener();
				} catch (error) {
					console.error("[next-reply] listener failed", error);
				}
			}
		}

		/**
		 * Merge a fetched/stored preference into the shared store.
		 * @param next - the Host's `{ directSend }`.
		 */
		function adopt(next) {
			if (next === null || typeof next !== "object") return;
			if (typeof next.directSend !== "boolean") return;
			store.directSend = next.directSend;
			store.ready = true;
			publish();
		}

		/**
		 * Load the preference once per page, sharing any in-flight request.
		 * @param force - bypass the memoized result.
		 */
		function loadConfig(force) {
			if (inflight !== null) return inflight;
			// A previously failed read must stay retryable: caching it forever would
			// pin the UI to the default for the life of the page.
			if (force !== true && store.ready && Date.now() - loadedAt < LOAD_TTL_MS) {
				return Promise.resolve();
			}
			inflight = fetch(CONFIG_URL, { headers: { accept: "application/json" } })
				.then((response) => (response.ok ? response.json() : null))
				.then((body) => {
					adopt(body);
					loadedAt = Date.now();
				})
				.catch((error) => {
					console.warn("[next-reply] could not read preference, using default", error);
				})
				.then(() => {
					inflight = null;
				});
			return inflight;
		}

		/**
		 * Persist the preference on the Host, then adopt the confirmed value.
		 * @param directSend - the new behaviour.
		 */
		function saveConfig(directSend) {
			// Optimistic: the switch responds immediately even on a slow disk.
			store.directSend = directSend;
			store.ready = true;
			publish();
			return fetch(CONFIG_URL, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify({ directSend })
			})
				.then((response) => (response.ok ? response.json() : null))
				.then((body) => {
					if (body !== null) adopt(body);
				})
				.catch((error) => {
					console.error("[next-reply] could not save preference", error);
				});
		}

		/**
		 * Subscribe one component to the shared preference.
		 * @returns the live store snapshot.
		 */
		function usePreference() {
			const [, bump] = react.useState(0);
			react.useEffect(() => {
				const listener = () => bump((value) => value + 1);
				listeners.add(listener);
				loadConfig(false);
				return () => {
					listeners.delete(listener);
				};
			}, []);
			return store;
		}

		// ------------------------------------------------------------ diagnostics

		/** Human wording for every reason the resolver can return. */
		const REASON_TEXT = {
			"no-chat": "拿不到会话快照",
			"no-order": "快照没有节点顺序",
			"no-nodes": "快照没有节点表",
			"no-answer": "本轮没有助手回答节点",
			"no-text": "回答节点里读不出文本",
			"no-marker": "回答里没有 suggest 标记",
			"empty-marker": "有标记但没有可用选项",
			"not-tail": "轮次判不出，且不是收尾回答"
		};

		let diagInflight = null;

		/**
		 * Read the Host's bounded ring of recent misses.
		 * @returns a promise for the entries, newest last.
		 */
		function loadDiag() {
			if (diagInflight !== null) return diagInflight;
			diagInflight = fetch(DIAG_URL, { headers: { accept: "application/json" } })
				.then((response) => (response.ok ? response.json() : null))
				.then((body) => (body !== null && Array.isArray(body.entries) ? body.entries : []))
				.catch(() => [])
				.then((entries) => {
					diagInflight = null;
					return entries;
				});
			return diagInflight;
		}

		/**
		 * Record one miss with the Host, at most once per Turn per page.
		 *
		 * Only the newest answer reports: a page load bursts every historical row
		 * through its effect, and an eight-entry ring filled with old Turns would
		 * answer nothing. Diagnostics must also never disturb the transcript, so
		 * every failure here is swallowed.
		 *
		 * @param chat - the chat snapshot slice.
		 * @param turn - the normalized Turn number, or undefined.
		 * @param reason - the resolver's classification.
		 */
		function reportMiss(chat, turn, reason) {
			if (reason === undefined) return;
			if (!isNewestAnswer(chat, turn)) return;
			const key = `${turn === undefined ? "?" : String(turn)}:${reason}`;
			if (reported.has(key)) return;
			if (reported.size >= REPORTED_LIMIT) reported.clear();
			reported.add(key);
			try {
				Promise.resolve(fetch(DIAG_URL, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({ reason, turn })
				})).catch(() => {});
			} catch {
				// A diagnostic is never worth an error in the flow.
			}
		}

		// -------------------------------------------------------------- parsing

		/**
		 * 1-based Turn number from anything the framework may hand over.
		 * `turnTail`'s owner prop is typed `TurnLocation`, which is an object in
		 * some builds and a plain integer in others; `node.location.turn` follows
		 * the same ambiguity. Folding every shape to a number is what makes the
		 * comparison below work at all.
		 * @param value - a TurnLocation, a Turn number, or nested `{turn}`.
		 * @returns the Turn number, or undefined when unusable.
		 */
		function turnOf(value) {
			let current = value;
			for (let depth = 0; depth < 3; depth += 1) {
				if (typeof current === "number") {
					return Number.isSafeInteger(current) && current >= 1 ? current : undefined;
				}
				if (current === null || typeof current !== "object") return undefined;
				current = current.turn;
			}
			return undefined;
		}

		/**
		 * Every string carried by a Chat node's data, joined.
		 * The assistant payload shape is not stable across builds: a user message
		 * carries `data.content` blocks, while an assistant step may carry a flat
		 * `text`, pre-rendered markdown, or something else again. Pinning one shape
		 * silently produced empty text and therefore no chips, so this walks the
		 * value instead. Only a marker regex runs on the result, so unrelated
		 * strings are harmless.
		 * @param node - one Chat node from the snapshot store.
		 * @returns the joined text, or "" when the node carries none.
		 */
		function textOf(node) {
			if (node === null || typeof node !== "object") return "";
			const data = node.data !== null && typeof node.data === "object" ? node.data : node;
			const parts = [];
			const take = (value) => {
				if (typeof value === "string" && value !== "") parts.push(value);
			};

			// Known shapes first: a block array, a flat text, pre-rendered markdown.
			if (Array.isArray(data.content)) {
				for (const block of data.content) {
					if (block !== null && typeof block === "object") take(block.text);
					else take(block);
				}
			}
			take(data.text);
			take(data.markdown);
			if (parts.length > 0) return parts.join("\n");

			// Last resort: walk the value, skipping keys that hold structure rather
			// than prose (otherwise `type: "text"` itself leaks into the text).
			const SKIP = new Set([
				"type", "kind", "role", "id", "key", "name", "messageId",
				"mediaType", "mimeType", "attachment", "attachments", "images"
			]);
			const walk = (value, depth) => {
				if (depth > 5 || value === null || value === undefined) return;
				if (typeof value === "string") {
					parts.push(value);
					return;
				}
				if (Array.isArray(value)) {
					for (const item of value) walk(item, depth + 1);
					return;
				}
				if (typeof value !== "object") return;
				for (const key of Object.keys(value)) {
					if (SKIP.has(key)) continue;
					walk(value[key], depth + 1);
				}
			};
			walk(data, 0);
			return parts.join("\n");
		}

		/** Wrap characters a model likes to put around a short suggestion. */
		const WRAPPING = /^["'“”‘’「」『』《》]+|["'“”‘’「」『』《》]+$/g;

		/**
		 * Coerce one raw fragment into a pill label.
		 * Collapses whitespace (a fenced list often wraps), drops list markers and
		 * numbers, peels wrapping quotes, and caps the length.
		 * @param raw - one candidate fragment.
		 * @returns the cleaned label, or "" when nothing usable is left.
		 */
		function normalizeChip(raw) {
			let text = String(raw).replace(/\s+/g, " ").trim();
			text = text.replace(/^[-*•·]+\s*/, "");
			text = text.replace(/^\d+[.)、]\s*/, "");
			text = text.replace(WRAPPING, "").trim();
			if (text.length > MAX_CHIP_CHARS) text = text.slice(0, MAX_CHIP_CHARS).trim();
			return text;
		}

		/**
		 * Turn a marker body into at most MAX_CHIPS distinct labels.
		 * Accepts `||` or one-per-line, and salvages a JSON array when the model
		 * ignores the delimiter convention entirely.
		 * @param raw - the body inside the marker.
		 * @returns the labels to render.
		 */
		function collectChips(raw) {
			const chips = [];
			const seen = new Set();
			const push = (value) => {
				if (chips.length >= MAX_CHIPS) return;
				const chip = normalizeChip(value);
				if (chip === "") return;
				const key = chip.toLowerCase();
				if (seen.has(key)) return;
				seen.add(key);
				chips.push(chip);
			};

			const body = String(raw).trim();
			// JSON first: a JSON array would otherwise survive the delimiter split as
			// one unreadable fragment.
			if (body.startsWith("[")) {
				try {
					const parsed = JSON.parse(body);
					if (Array.isArray(parsed)) {
						for (const item of parsed) {
							if (typeof item === "string" || typeof item === "number") push(String(item));
						}
						if (chips.length > 0) return chips;
					}
				} catch {
					// Fall through to delimiter parsing.
				}
			}

			let parts = body.split("||");
			if (parts.length <= 1) parts = body.split(/\r?\n/);
			for (const part of parts) push(part);
			return chips;
		}

		/**
		 * Parse up to MAX_CHIPS options out of one marker, in either accepted shape.
		 * @param text - the assistant text to scan.
		 * @returns trimmed, de-duplicated, non-empty options.
		 */
		function parseChips(text) {
			if (typeof text !== "string" || text === "") return [];
			const match = FENCE_MARKER.exec(text) ?? COMMENT_MARKER.exec(text);
			if (match === null) return [];
			return collectChips(match[1]);
		}

		/**
		 * Whether the text carries a marker at all, valid or not.
		 * @param text - the assistant text.
		 * @returns true when one of the two accepted shapes is present.
		 */
		function hasMarker(text) {
			if (typeof text !== "string" || text === "") return false;
			return FENCE_MARKER.test(text) || COMMENT_MARKER.test(text);
		}

		/**
		 * Newest assistant step of this Turn that actually carries a marker.
		 * Walking backwards handles retries and interrupted steps, where one
		 * Turn holds several assistant-step nodes.
		 * @param chat - the chat snapshot slice.
		 * @param turn - the 1-based Turn to read.
		 * @returns `{ chips, reason }`; reason is "ok" when chips were found.
		 */
		function inspectTurn(chat, turn) {
			if (chat === null || typeof chat !== "object") return { chips: [], reason: "no-chat" };
			const order = chat.order;
			const nodes = chat.nodes;
			if (!Array.isArray(order) || order.length === 0) return { chips: [], reason: "no-order" };
			if (nodes === null || typeof nodes !== "object" || typeof nodes.get !== "function") {
				return { chips: [], reason: "no-nodes" };
			}
			let sawAnswer = false;
			let sawText = false;
			let sawMarker = false;
			for (let index = order.length - 1; index >= 0; index -= 1) {
				const node = nodes.get(order[index]);
				if (!node || node.kind !== "assistant-step") continue;
				if (turnOf(node.location) !== turn) continue;
				sawAnswer = true;
				const text = textOf(node);
				if (text !== "") sawText = true;
				if (hasMarker(text)) sawMarker = true;
				const chips = parseChips(text);
				if (chips.length > 0) return { chips, reason: "ok" };
			}
			if (!sawAnswer) return { chips: [], reason: "no-answer" };
			if (!sawText) return { chips: [], reason: "no-text" };
			return { chips: [], reason: sawMarker ? "empty-marker" : "no-marker" };
		}

		/**
		 * Fallback used when no Turn number can be compared: the newest answer that
		 * carries a marker, but only while that answer still closes the Chat flow
		 * (only `turn-tail` rows may follow it). This keeps the row from also
		 * appearing under older Turns.
		 * @param chat - the chat snapshot slice.
		 * @returns `{ chips, reason }`.
		 */
		function inspectTail(chat) {
			if (chat === null || typeof chat !== "object") return { chips: [], reason: "no-chat" };
			const order = chat.order;
			const nodes = chat.nodes;
			if (!Array.isArray(order) || order.length === 0) return { chips: [], reason: "no-order" };
			if (nodes === null || typeof nodes !== "object" || typeof nodes.get !== "function") {
				return { chips: [], reason: "no-nodes" };
			}
			let onlyTailsFollow = true;
			for (let index = order.length - 1; index >= 0; index -= 1) {
				const node = nodes.get(order[index]);
				if (!node || typeof node !== "object") return { chips: [], reason: "no-nodes" };
				if (node.kind === "assistant-step") {
					if (!onlyTailsFollow) return { chips: [], reason: "not-tail" };
					const text = textOf(node);
					const chips = parseChips(text);
					if (chips.length > 0) return { chips, reason: "ok" };
					if (text === "") return { chips: [], reason: "no-text" };
					return { chips: [], reason: hasMarker(text) ? "empty-marker" : "no-marker" };
				}
				if (node.kind !== "turn-tail") onlyTailsFollow = false;
			}
			return { chips: [], reason: "no-answer" };
		}

		/**
		 * Resolve the chips for one rendered Turn, and why there are none.
		 * @param chat - the chat snapshot slice.
		 * @param turn - the normalized Turn number, or undefined.
		 * @returns `{ chips, reason }`.
		 */
		function inspect(chat, turn) {
			// A resolved Turn keeps the row turn-scoped; the tail fallback exists only
			// for a build whose Turn prop cannot be normalized at all.
			if (turn !== undefined) return inspectTurn(chat, turn);
			return inspectTail(chat);
		}

		/**
		 * One-shot diagnostic rendered in place of the row when nothing matched.
		 * It describes only the brief shape of what the renderer handed over, so a
		 * single glance says which link of the chain is broken: no chat slice, no
		 * node map, an unexpected node kind, or simply no marker in the text.
		 * @param chat - the chat snapshot slice, if any.
		 * @param rawTurn - the owner's `turn` prop, verbatim.
		 */
		function diagLine(chat, rawTurn) {
			const hasChat = chat !== undefined && chat !== null;
			const order = hasChat && Array.isArray(chat.order) ? chat.order : undefined;
			const nodes = hasChat && chat.nodes && typeof chat.nodes.get === "function" ? chat.nodes : undefined;
			const kinds = [];
			if (order !== undefined && nodes !== undefined) {
				for (const key of order.slice(-6)) {
					const node = nodes.get(key);
					kinds.push(node && node.kind ? node.kind : "?");
				}
			}
			const turnText = rawTurn !== null && typeof rawTurn === "object" ? JSON.stringify(rawTurn) : String(rawTurn);
			return react.createElement(
				"div",
				{
					style: {
						fontSize: "11px",
						lineHeight: "16px",
						color: TOKEN.text,
						opacity: 0.75,
						fontFamily: "ui-monospace, monospace",
						margin: "6px 0 2px",
						wordBreak: "break-all"
					}
				},
				`[next-reply] 诊断 · turn=${turnText} · order=${order === undefined ? "无" : order.length} · nodes=${nodes === undefined ? "无" : "map"} · 尾部=${kinds.length === 0 ? "空" : kinds.join(",")}`
			);
		}

		/**
		 * Whether this row belongs to the newest answer in the flow, i.e. only
		 * `turn-tail` rows follow it. Used to place the diagnostic exactly once,
		 * under the answer the user just received.
		 * @param chat - the chat snapshot slice.
		 * @param turn - the normalized Turn number, or undefined.
		 * @returns true when this row is the newest answer's.
		 */
		function isNewestAnswer(chat, turn) {
			if (chat === null || typeof chat !== "object") return false;
			const order = chat.order;
			const nodes = chat.nodes;
			if (!Array.isArray(order) || order.length === 0) return false;
			if (nodes === null || typeof nodes !== "object" || typeof nodes.get !== "function") return false;
			let onlyTailsFollow = true;
			for (let index = order.length - 1; index >= 0; index -= 1) {
				const node = nodes.get(order[index]);
				if (!node || typeof node !== "object") return false;
				if (node.kind === "assistant-step") {
					return onlyTailsFollow && (turn === undefined || turnOf(node.location) === turn);
				}
				if (node.kind !== "turn-tail") onlyTailsFollow = false;
			}
			return false;
		}

		// ------------------------------------------------------------ chip row

		/**
		 * Pill styling, in the theme's own tokens.
		 * @param disabled - whether the chip is currently inert.
		 */
		function chipStyle(disabled) {
			return {
				appearance: "none",
				font: "inherit",
				fontSize: "12px",
				lineHeight: "20px",
				maxWidth: "260px",
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
				padding: "4px 12px",
				borderRadius: "999px",
				border: "1px solid " + TOKEN.border,
				background: "transparent",
				color: disabled ? TOKEN.text : TOKEN.textStrong,
				opacity: disabled ? 0.55 : 1,
				cursor: disabled ? "default" : "pointer",
				transition: "background 120ms ease"
			};
		}

		/**
		 * Expand one pill to its whole label, or put it back.
		 * A 260px ellipsis hides exactly the words that make a suggestion
		 * decidable, so hovering trades the tidy row for the full sentence.
		 * @param event - the mouse or focus event.
		 * @param open - true to expand.
		 */
		function expand(event, open) {
			const node = event && event.currentTarget;
			if (node === undefined || node === null || node.style === undefined) return;
			node.style.maxWidth = open ? "min(420px, 100%)" : "260px";
			node.style.whiteSpace = open ? "normal" : "nowrap";
			node.style.textAlign = open ? "left" : "";
		}

		/**
		 * One row of next-reply chips for the Turn being closed.
		 * Renders nothing when the reply carried no marker, so unmarked turns
		 * leave no gap.
		 * @param props - turnTail owner props plus the standard session props.
		 */
		function NextReply(props) {
			const useChat = props.useChat;
			const useSession = props.useSession;
			const useInput = props.useInput;
			const inputActions = props.inputActions;

			// Two independent routes to the chat slice: some builds publish it only
			// through `useChat`, others also carry `session.chat` on the snapshot.
			const session = typeof useSession === "function" ? useSession(ALL) : undefined;
			const hooked = typeof useChat === "function" ? useChat(ALL) : undefined;
			const chat = hooked ?? (session !== null && typeof session === "object" ? session.chat : undefined);
			// Published input state: the only honest way to know whether the
			// composer is empty and whether the editor will accept an edit.
			const input = typeof useInput === "function" ? useInput(ALL) : undefined;

			const preference = usePreference();
			const [picked, setPicked] = react.useState(null);

			const turn = turnOf(props.turn);
			const found = react.useMemo(() => inspect(chat, turn), [chat, turn]);
			const chips = found.chips;

			react.useEffect(() => {
				if (chips.length > 0) return;
				reportMiss(chat, turn, found.reason);
			}, [chat, turn]);

			if (chips.length === 0) {
				if (DIAG_ON && isNewestAnswer(chat, turn)) return diagLine(chat, props.turn);
				return null;
			}

			const directSend = preference.directSend !== false;
			const busy = input !== undefined && input !== null && typeof input === "object"
				? typeof input.phase === "string" && input.phase !== "plain"
				: (session !== null && typeof session === "object" && session.running === true);
			const draft = input !== undefined && input !== null && typeof input === "object" && typeof input.draft === "string"
				? input.draft
				: "";
			const attachments = input !== undefined && input !== null && typeof input === "object" && Array.isArray(input.attachmentIds)
				? input.attachmentIds.length
				: 0;
			/** Anything already in the composer that a click would destroy. */
			const hasDraft = draft.trim() !== "" || attachments > 0;

			const actions = inputActions !== undefined && inputActions !== null ? inputActions : undefined;
			const canInsert = actions !== undefined
				&& typeof actions.captureInsertion === "function"
				&& typeof actions.insertText === "function";
			const canReplace = actions !== undefined && typeof actions.setDraft === "function";
			// A whole-draft replacement is only acceptable on an empty composer; with
			// text in the way, either the guarded insert works or the chip is inert.
			const canApply = canInsert || (!hasDraft && canReplace);
			// Sending must never overwrite work in progress: while the composer holds
			// anything, send-mode chips wait instead of clearing it.
			const disabled = busy || picked !== null || !canApply || (directSend && hasDraft);

			/**
			 * Put one option into the composer and, in send mode, submit it.
			 *
			 * The guarded insert comes first because it is the only path that is
			 * undoable, keeps reference chips and later edits intact, and refuses
			 * outright when the draft revision moved under it. `setDraft` is the
			 * fallback for older builds and is only ever used on an empty composer.
			 *
			 * @param text - the option to apply.
			 * @returns whether the composer accepted it.
			 */
			const apply = (text) => {
				if (actions === undefined) return false;
				let inserted = false;
				if (canInsert) {
					try {
						inserted = actions.insertText(text, actions.captureInsertion()) === true;
					} catch (error) {
						console.error("[next-reply] guarded insert failed", error);
					}
				}
				if (!inserted) {
					// Never trade a whole draft for a suggestion: refuse instead.
					if (hasDraft || !canReplace) return false;
					actions.setDraft(text);
				}
				if (directSend) actions.submit();
				return true;
			};

			/**
			 * Apply one option, ignoring a repeated click on the same label.
			 * @param text - the option to apply.
			 */
			const choose = (text) => {
				if (disabled) return;
				const now = Date.now();
				if (lastPick.text === text && now - lastPick.at < CLICK_COOLDOWN_MS) return;
				lastPick = { text, at: now };
				const applied = apply(text);
				if (applied && directSend) setPicked(text);
			};

			/**
			 * Explain a pill's state before it is clicked.
			 * @param text - the option behind this pill.
			 * @returns the tooltip text.
			 */
			const tooltip = (text) => {
				if (picked !== null) return "已发送：" + text;
				if (busy) return text + "（会话正在运行，稍候）";
				if (directSend && hasDraft) return text + "（输入框已有草稿：清空后再点，或改成「填入输入框」）";
				return directSend ? text : text + "（填入输入框，待你确认）";
			};

			if (picked !== null) {
				return react.createElement(
					"div",
					{ style: { display: "flex", flexWrap: "wrap", gap: "8px", margin: "8px 0 4px" } },
					react.createElement(
						"span",
						{ style: { fontSize: "12px", lineHeight: "28px", color: TOKEN.text, opacity: 0.8 } },
						"已发送：" + picked
					)
				);
			}

			return react.createElement(
				"div",
				{ style: { display: "flex", flexWrap: "wrap", gap: "8px", margin: "8px 0 4px" } },
				chips.map((text, index) => react.createElement(
					"button",
					{
						key: text,
						type: "button",
						title: tooltip(text),
						"aria-label": `第 ${index + 1} 个下一步建议：${text}`,
						disabled,
						style: chipStyle(disabled),
						onClick: () => choose(text),
						onMouseEnter: (event) => {
							if (!disabled) event.currentTarget.style.background = TOKEN.surface;
							expand(event, true);
						},
						onMouseLeave: (event) => {
							event.currentTarget.style.background = "transparent";
							expand(event, false);
						},
						onFocus: (event) => expand(event, true),
						onBlur: (event) => expand(event, false)
					},
					text
				))
			);
		}

		// ------------------------------------------------------- settings page

		/**
		 * One radio option row.
		 * @param options - the option description and current selection.
		 */
		function RadioRow({ checked, label, hint, onSelect }) {
			return react.createElement(
				"label",
				{
					style: {
						display: "flex",
						alignItems: "flex-start",
						gap: "10px",
						padding: "10px 12px",
						border: "1px solid " + (checked ? TOKEN.accent : TOKEN.border),
						borderRadius: "10px",
						cursor: "pointer",
						background: checked ? TOKEN.surface : "transparent"
					}
				},
				react.createElement("input", {
					type: "radio",
					name: "next-reply-mode",
					checked,
					onChange: onSelect,
					style: { marginTop: "2px", accentColor: TOKEN.accent }
				}),
				react.createElement(
					"span",
					{ style: { display: "flex", flexDirection: "column", gap: "2px" } },
					react.createElement("span", { style: { fontSize: "13px", color: TOKEN.textStrong } }, label),
					react.createElement("span", { style: { fontSize: "12px", color: TOKEN.text } }, hint)
				)
			);
		}

		/**
		 * The Host's bounded ring of recent misses, so "没有出现按钮" has an answer
		 * without opening a devtools console.
		 */
		function MissList() {
			const [entries, setEntries] = react.useState(undefined);
			react.useEffect(() => {
				let live = true;
				loadDiag().then((loaded) => {
					if (live) setEntries(loaded);
				});
				return () => {
					live = false;
				};
			}, []);

			const rows = Array.isArray(entries) ? entries : [];
			return react.createElement(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "4px" } },
				react.createElement(
					"span",
					{ style: { fontSize: "13px", color: TOKEN.textStrong } },
					"最近没有出现建议的轮次"
				),
				react.createElement(
					"span",
					{ style: { fontSize: "12px", color: TOKEN.text } },
					rows.length === 0
						? "暂无记录。只有最新一轮才会记一条；重启 DSH 后清空。"
						: "最新的在最下面。模型没给 suggest 块是最常见的一类，重开一轮即可。"
				),
				rows.length === 0
					? null
					: react.createElement(
						"div",
						{
							style: {
								fontSize: "12px",
								fontFamily: "ui-monospace, monospace",
								color: TOKEN.text,
								background: TOKEN.surface,
								border: "1px solid " + TOKEN.border,
								borderRadius: "8px",
								padding: "8px 10px",
								display: "flex",
								flexDirection: "column",
								gap: "2px"
							}
						},
						rows.map((entry, index) => react.createElement(
							"span",
							{ key: index },
							`${formatTime(entry && entry.at)} · 第 ${entry && entry.turn !== undefined ? entry.turn : "?"} 轮 · ${REASON_TEXT[entry && entry.reason] ?? (entry && entry.reason) ?? "未知"}`
						))
					)
			);
		}

		/**
		 * `HH:MM:SS` from an ISO stamp, or a dash when it cannot be read.
		 * @param value - the Host's `at` field.
		 * @returns a short local time.
		 */
		function formatTime(value) {
			if (typeof value !== "string") return "--:--:--";
			const at = new Date(value);
			if (Number.isNaN(at.getTime())) return "--:--:--";
			const pad = (n) => (n < 10 ? "0" + n : String(n));
			return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
		}

		/**
		 * Settings page: what a chip click does, and why none appeared.
		 */
		function NextReplySettings() {
			const preference = usePreference();
			const directSend = preference.directSend !== false;

			return react.createElement(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "12px", maxWidth: "620px" } },
				react.createElement(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "4px" } },
					react.createElement("h3", { style: { margin: 0, fontSize: "15px", color: TOKEN.textStrong } }, "下一步建议"),
					react.createElement(
						"p",
						{ style: { margin: 0, fontSize: "12px", color: TOKEN.text } },
						"每条回答下方最多 3 个可点的下一步建议。这里决定点击之后的行为。"
					)
				),
				react.createElement(RadioRow, {
					checked: directSend,
					label: "直接发送",
					hint: "点一下，这句话立刻作为你的下一条消息发出去。输入框里已有草稿时不发送，避免覆盖。",
					onSelect: () => saveConfig(true)
				}),
				react.createElement(RadioRow, {
					checked: !directSend,
					label: "填入输入框，待我确认",
					hint: "点一下只把它插到光标处（可撤销），你可以改完再自己发。",
					onSelect: () => saveConfig(false)
				}),
				react.createElement(MissList, null)
			);
		}

		// --------------------------------------------------------- registration

		/**
		 * Swallow the `suggest` block so the raw options never reach the transcript.
		 * A hoc layer that renders nothing replaces the code block it wraps; the
		 * same text is still parsed out of the durable message by the chip row.
		 */
		function HideSuggestFence() {
			return null;
		}

		/**
		 * Register the chip row, the fence hider, and the settings page.
		 * @param ctx - Client Cordis context.
		 */
		function apply(ctx) {
			ctx.slots.inject(SLOT, () => ctx.slots.register({
				name: SLOT,
				id: CELL_ID,
				order: CELL_ORDER
			}, NextReply));

			try {
				ctx.slots.inject(FENCE_SLOT, () => ctx.slots.register({
					name: FENCE_SLOT,
					id: "next-reply-fence",
					key: FENCE_KEY,
					order: 0
				}, HideSuggestFence));
			} catch (error) {
				console.warn("[next-reply] the suggest fence could not be hidden", error);
			}

			ctx.slots.inject(SETTINGS_SLOT, () => ctx.slots.register({
				name: SETTINGS_SLOT,
				id: SETTINGS_ID,
				order: SETTINGS_ORDER,
				label: "下一步建议"
			}, NextReplySettings));
		}

		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	}
});
