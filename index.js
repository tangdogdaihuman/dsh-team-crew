/**
 * @local/dsh-team-crew — Host plugin that adds the two missing Agent Teams
 * capabilities: hot model/effort switch for a live teammate (memory intact) and
 * soft deletion ("retire") of a member the roster can otherwise never drop.
 *
 * Red lines it honours (spec §4):
 *  1. the Team journal and its immutable identity fields are never touched.
 *     Retirement is a plugin-owned side ledger, enforced on the model-facing
 *     tool surface through the registry's declared extension points:
 *     `ctx.tools.guard()` (monotonic delivery denial) and
 *     `tools/post-execute` (roster result rewrite).
 *  2. a switch never splits an in-flight turn: while the teammate is `running`
 *     the switch is queued and lands at the turn gap (`agent/status` -> idle)
 *     or at her next activation (`agent/created`).
 *  3/4. every hook is contained, and a startup self-check names each missing
 *     piece in the Host log AND in every tool result while the degradation
 *     lasts — never a silent half-workings.
 *
 * The switch reuses the platform's own selection seam (`installModelSelection`
 * from @deepseek-ai/dsh-agent, plus the existing log-only `model/selection`
 * event), which is exactly the path the GUI model picker takes — so prompt
 * assembly variables, the `agent/request` route override, and the durable
 * `[model changed]` notice all stay consistent with a native switch.
 *
 * @module @local/dsh-team-crew
 */
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

/** Cordis plugin name. */
export const name = "team-crew";

/** Required services; a profile missing any of them leaves this plugin inactive (loud, by design). */
export const inject = [
	"agents",
	"agentTeams",
	"commands",
	"llm",
	"storageDomain",
	"subagents",
	"tools"
];

/** Tunables, changeable in the profile's `cordis.patch.yml`. */
export const Config = z.object({
	/** Queue a model switch while the teammate is running instead of switching at her next step. */
	deferModelSwitchWhileRunning: z.boolean().default(true),
	/** Release the teammate's live activation (drain the continuable child) on retire. */
	drainOnRetire: z.boolean().default(true)
});

/** Ledger domain name (storage unit names must match `[a-z][a-z0-9_]*`). */
const DOMAIN_NAME = "team_crew";
/** Ledger table name. */
const TABLE_NAME = "members";
/** Longest wait for one continuable-child release before reporting it unfinished. */
const DRAIN_TIMEOUT_MS = 20000;
/** Model ids advertised in a rejection message. */
const CATALOG_HINT_LIMIT = 40;

//#region ledger record shape
// The domain layer only ever calls `parse`/`safeParse` on a table schema, so one
// hand-written validator keeps this bundle free of a `zod` resolution
// dependency (a profile-installed bundle must not guess the Host's store layout).
function text(value, max) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > max) return void 0;
	return trimmed;
}
function stamp(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : void 0;
}
/**
 * Validate and normalize one stored ledger row.
 *
 * Unknown keys are dropped, so a newer plugin generation's extra fields never
 * poison an older reader, and a malformed row fails the domain open loudly
 * rather than being half-trusted.
 * @param raw - the record as read back from the storage backend.
 * @returns the normalized record.
 */
function normalizeRecord(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("ledger record must be a plain object");
	const key = text(raw.key, 512);
	const rootSessionId = text(raw.rootSessionId, 256);
	const memberName = text(raw.memberName, 128);
	const childSessionId = text(raw.childSessionId, 256);
	if (!key || !rootSessionId || !memberName || !childSessionId) throw new TypeError("ledger record is missing an identity field");
	if (raw.retired !== void 0 && typeof raw.retired !== "boolean") throw new TypeError("ledger record.retired must be a boolean");
	const retiredAt = stamp(raw.retiredAt);
	const retireReason = text(raw.retireReason, 500);
	const provider = text(raw.provider, 128);
	const model = text(raw.model, 256);
	const effort = text(raw.effort, 64);
	const switchUpdatedAt = stamp(raw.switchUpdatedAt);
	const switchState = raw.switchState === "applied" || raw.switchState === "pending" ? raw.switchState : void 0;
	return {
		key,
		rootSessionId,
		memberName,
		childSessionId,
		retired: raw.retired === true,
		...retiredAt === void 0 ? {} : { retiredAt },
		...retireReason === void 0 ? {} : { retireReason },
		...provider === void 0 ? {} : { provider },
		...model === void 0 ? {} : { model },
		...effort === void 0 ? {} : { effort },
		...switchState === void 0 ? {} : { switchState },
		...switchUpdatedAt === void 0 ? {} : { switchUpdatedAt }
	};
}
const recordSchema = {
	parse: (value) => normalizeRecord(value),
	safeParse: (value) => {
		try {
			return {
				success: true,
				data: normalizeRecord(value)
			};
		} catch (error) {
			return {
				success: false,
				error
			};
		}
	}
};
/**
 * Plugin-owned side state; the Team journal itself is never written. Exported so
 * an operator or a test can open the very same domain without reaching into
 * plugin internals (`team-crew-persistence-probe.mjs` does exactly that).
 */
export const crewLedger = defineDomain({
	name: DOMAIN_NAME,
	version: 1,
	tables: { [TABLE_NAME]: domainTable(recordSchema) }
});
//#endregion
//#region tool schemas
const ROUTE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		provider: { type: "string" },
		model: { type: "string" },
		reasoning_effort: { type: "string" }
	}
};
const MODEL_CATALOG_SCHEMA = {
	type: "array",
	items: {
		type: "object",
		additionalProperties: false,
		properties: {
			provider: { type: "string" },
			model: { type: "string" },
			name: { type: "string" },
			image_input: { type: "boolean" }
		}
	}
};
const SET_MODEL_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		target: {
			type: "string",
			required: true
		},
		/** `applied` = effective from her next request; `pending` = queued for the turn gap or next activation; `unchanged` = a read-only call. */
		state: {
			type: "string",
			required: true,
			enum: ["applied", "pending", "unchanged"]
		},
		previous: {
			...ROUTE_SCHEMA,
			required: true
		},
		selected: {
			...ROUTE_SCHEMA,
			required: true
		},
		context: {
			type: "string",
			required: true
		},
		persisted: {
			type: "boolean",
			required: true
		},
		note: { type: "string" },
		models: MODEL_CATALOG_SCHEMA
	}
};
const RETIRE_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		target: {
			type: "string",
			required: true
		},
		action: {
			type: "string",
			required: true,
			enum: ["retired", "restored", "already-retired", "not-retired"]
		},
		wasRunning: { type: "boolean" },
		released: { type: "boolean" },
		persisted: {
			type: "boolean",
			required: true
		},
		note: {
			type: "string",
			required: true
		}
	}
};
/** The canonical value IS the model-facing result. */
function jsonOutput(schema) {
	return {
		schema,
		render: (_args, value) => [{
			type: "text",
			text: JSON.stringify(value)
		}]
	};
}
//#endregion
//#region small helpers
/** Shape one route for a tool output; unknown fields are omitted. */
function routeValue(route = {}) {
	return {
		...typeof route.provider === "string" ? { provider: route.provider } : {},
		...typeof route.model === "string" ? { model: route.model } : {},
		...typeof route.reasoningEffort === "string" ? { reasoning_effort: route.reasoningEffort } : typeof route.effort === "string" ? { reasoning_effort: route.effort } : {}
	};
}
function sameRoute(left = {}, right = {}) {
	return (left.provider ?? void 0) === (right.provider ?? void 0) && (left.model ?? void 0) === (right.model ?? void 0) && (left.effort ?? left.reasoningEffort ?? void 0) === (right.effort ?? right.reasoningEffort ?? void 0);
}
/** Reject after `ms` unless `promise` settles first; the timer never leaks. */
function withTimeout(promise, ms, signal) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`operation did not settle within ${ms}ms`)), ms);
		const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
		if (signal !== void 0) {
			if (signal.aborted) return void (clearTimeout(timer), reject(signal.reason));
			signal.addEventListener("abort", onAbort, { once: true });
		}
		promise.then((value) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
		}, (error) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
	});
}
/**
 * Read the route the teammate's OWN session log froze at spawn.
 *
 * A cold (non-resident) teammate has no live Agent, so neither the request
 * header nor `agent.options` exist; the continuable descriptor is the only
 * truthful answer. Best-effort: any failure returns an empty route and the
 * caller then asks for an explicit provider.
 */
async function descriptorRoute(ctx, childId) {
	const query = ctx.get("sessionQuery");
	if (query === void 0 || typeof query.observeSession !== "function") return {};
	let observation;
	try {
		observation = await query.observeSession(childId, { projectionMode: "none" });
		const events = observation.events.slice(observation.inheritedEventCount ?? 0);
		const descriptor = foldSubagentDescriptor(events);
		if (descriptor === void 0 || descriptor.mode !== "continuable") return {};
		return {
			...typeof descriptor.agentProvider === "string" ? { provider: descriptor.agentProvider } : {},
			...typeof descriptor.agentModel === "string" ? { model: descriptor.agentModel } : {},
			...typeof descriptor.agentReasoningEffort === "string" ? { reasoningEffort: descriptor.agentReasoningEffort } : {}
		};
	} catch {
		return {};
	} finally {
		// The observation owns a retained read handle; release whichever way it closes.
		for (const close of [observation?.[Symbol.asyncDispose], observation?.[Symbol.dispose], observation?.close, observation?.dispose]) {
			if (typeof close !== "function") continue;
			try {
				const result = close.call(observation);
				if (result !== void 0 && typeof result.catch === "function") result.catch(() => {});
			} catch {}
			break;
		}
	}
}
//#endregion
/**
 * The route one live agent actually answers on.
 *
 * The latest logged request header is authoritative once a turn has run (the
 * agent loop seeds its next config from it); creation options only cover the
 * window before the first request. An effort the adapter defaulted is not a
 * conversation choice, so it is not reported as one — same rule the platform's
 * own selection surface uses.
 * @param agent - live teammate agent, when one exists.
 */
function routeOf(agent) {
	if (agent === void 0) return {};
	try {
		const header = agent.session.requestHeader();
		const config = header?.config;
		if (typeof config?.provider === "string" && typeof config.model === "string") return {
			provider: config.provider,
			model: config.model,
			...header?.adapterDefaults?.reasoningEffort === true || typeof config.reasoningEffort !== "string" ? {} : { reasoningEffort: config.reasoningEffort }
		};
	} catch {}
	const options = agent.options ?? {};
	return {
		...typeof options.provider === "string" ? { provider: options.provider } : {},
		...typeof options.model === "string" ? { model: options.model } : {},
		...typeof options.reasoningEffort === "string" ? { reasoningEffort: options.reasoningEffort } : {}
	};
}
/** Register the crew tool set in one exact Lead Agent scope. */
function install(agent, ctx, runtime) {
	const scoped = agent.ctx;
	const disposers = [];
	const register = (disposer) => {
		disposers.push(disposer);
	};
	try {
		register(scoped.tools.register(defineTool({
			name: "set_teammate_model",
			description: "Hot-swap one teammate's model (and optionally her reasoning effort) WITHOUT losing her memory: her conversation history, identity, and workspace stay intact, and the new route is used from her next request onward. Only the Team Lead may call this. Omitting `model` and `provider` keeps her current route, which is how you change only the effort. Unknown model ids are rejected with the provider's real catalog in the error, so you can discover routes without guessing; `list_models: true` reads that catalog without changing anything. A teammate mid-turn finishes that turn on her current model; the switch then lands at the turn gap (or her next activation).",
			parameters: {
				target: {
					type: "string",
					required: true,
					description: "Teammate name from list_agents (the Lead cannot be targeted)."
				},
				model: {
					type: "string",
					description: "Target model id, or `provider/model` when the provider is not her current one. Omit to keep her current model."
				},
				provider: {
					type: "string",
					description: "Registered provider route owning `model`. Omit to keep her current provider."
				},
				reasoning_effort: {
					type: "string",
					description: "Adapter-owned thinking effort (values such as none/minimal/low/medium/high/xhigh, per model; an unsupported value is rejected with the supported list). Omitted with a changed model = that model's own default; omitted with an unchanged model = keep her current effort."
				},
				list_models: {
					type: "boolean",
					description: "Return the model catalog for `provider` (or her current provider) and change nothing."
				}
			},
			output: jsonOutput(SET_MODEL_OUTPUT_SCHEMA),
			execute(args, exec) {
				return runtime.setModel(callerAgent(exec, "set_teammate_model"), args, exec);
			}
		})));
		register(scoped.tools.register(defineTool({
			name: "retire_teammate",
			description: "Soft-delete one teammate: she disappears from list_agents, and send_message / interrupt_agent / task reassignment aimed at her are refused with an explicit denial, so nothing routes to her any more. The durable Team journal is untouched, which means `action: \"restore\"` brings the very same member back (same session, same memory). Only the Team Lead may call this. Use it for a member who is done for good; use set_teammate_model to change her brain instead of replacing her.",
			parameters: {
				target: {
					type: "string",
					required: true,
					description: "Teammate name from list_agents (the Lead cannot be targeted)."
				},
				action: {
					type: "string",
					enum: ["retire", "restore"],
					description: "retire (default) = leave the roster and refuse delivery; restore = undo a previous retire."
				},
				reason: {
					type: "string",
					description: "Why she is being retired; recorded in the plugin ledger and quoted back in denials."
				},
				release: {
					type: "boolean",
					description: "On retire, also release her live activation (default true): an active turn is interrupted and the resident child is drained, so nothing keeps running in the background. Her persisted session stays on disk either way."
				}
			},
			output: jsonOutput(RETIRE_OUTPUT_SCHEMA),
			execute(args, exec) {
				return runtime.retire(callerAgent(exec, "retire_teammate"), args, exec);
			}
		})));
		// The human-facing /crew command is registered ONCE at the global layer in
		// apply() (see "global /crew command"), because this host's Agent scopes
		// inject `tools` but NOT `commands`: reading `scoped.commands` on a Cordis
		// context proxy throws "cannot get property ... without inject" — and that
		// very throw inside v1.1.1's optional-chaining guard rolled back BOTH model
		// tools (v1.1.1 regression, caught in live acceptance). Do not re-add a
		// per-agent command registration here without first proving the target
		// scope actually injects `commands` (probe with `"commands" in scoped` AND
		// a try/catch around the property read, never optional chaining alone).
	} catch (error) {
		for (const dispose of disposers.reverse()) try {
			dispose();
		} catch {}
		throw error;
	}
	return () => {
		for (const dispose of disposers.reverse()) try {
			dispose();
		} catch {}
	};
}
/** Recover the exact caller guaranteed by Agent-scoped tool discovery. */
function callerAgent(exec, toolName) {
	if (exec.agent === void 0) throw new Error(`${toolName} requires a calling Agent`);
	return exec.agent;
}
/**
 * Plugin entry point.
 * @param ctx - Host context.
 * @param config - Validated plugin config.
 */
export function apply(ctx, config = {}) {
	const resolved = {
		deferModelSwitchWhileRunning: config.deferModelSwitchWhileRunning ?? true,
		drainOnRetire: config.drainOnRetire ?? true
	};
	/** Degradation notes: never silence, always reported (red line 4). */
	const notes = [];
	/** `${rootId}::${memberName}` -> ledger record; synchronous reads keep `tools/guard` cheap. */
	const records = new Map();
	/** childSessionId -> ledger record. */
	const byChild = new Map();
	/** agentId -> { agent, ref, dispose }: the plugin-owned selection shim per live teammate. */
	const selections = new Map();
	const keyOf = (rootId, memberName) => `${String(rootId).replace(/[^a-zA-Z0-9_-]/g, "_")}__${memberName.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
	const message = (error) => error instanceof Error ? error.message : String(error);
	const warn = (text) => {
		try {
			ctx.logger.warn(`team-crew: ${text}`);
		} catch {}
	};
	const note = (text) => {
		if (!notes.some((entry) => entry === text)) notes.push(text);
	};
	/**
	 * One self-check line. A missing piece is named in the Host log and in every
	 * tool result while it lasts; the capability it gates is then disabled.
	 */
	function probe(label, test) {
		try {
			if (test()) return true;
			warn(`self-check found no usable ${label}; the capability behind it is disabled`);
		} catch (error) {
			warn(`self-check of ${label} threw: ${message(error)}; the capability behind it is disabled`);
		}
		note(`${label} unavailable`);
		return false;
	}
	// ---------------------------------------------------------------- self-check
	const hasRoster = probe("agentTeams roster", () => typeof ctx.agentTeams?.listMembers === "function" && typeof ctx.agentTeams?.tryMembership === "function" && typeof ctx.agentTeams?.membership === "function");
	const hasRegistry = probe("agent registry", () => typeof ctx.agents?.get === "function" && typeof ctx.agents?.list === "function" && typeof ctx.on === "function");
	const canValidate = probe("llm route validation", () => typeof ctx.llm?.resolveCallConfig === "function");
	const canSelect = probe("model-selection seam (installModelSelection)", () => typeof installModelSelection === "function");
	const canDeny = probe("tool guard (delivery denial)", () => typeof ctx.tools?.guard === "function");
	const canRewrite = probe("tool post-execute (roster rewrite)", () => typeof ctx.on === "function");
	const canRelease = probe("subagent activation release", () => typeof ctx.subagents?.drainContinuableChildren === "function");
	const usable = hasRoster && hasRegistry && canValidate && canSelect;
	// ------------------------------------------------------- global /crew command
	// The host's Agent scopes inject `tools` but NOT `commands` (reading
	// `scoped.commands` in a Lead scope throws "cannot get property ... without
	// inject" — the v1.1.1 regression), so the human-facing command is registered
	// once at the global layer, exactly like the official /goal command. Safety:
	// every crewCommand sub-command resolves `invocation.agent` through
	// snapshot()/setModel()/retire(), which all demand a Lead membership first,
	// so a non-Lead session calling /crew gets an explicit error, never the
	// operations. The per-agent registration inside install() remains as the
	// preferred path for hosts that DO inject commands into Agent scopes.
	if (usable && typeof ctx.commands?.register === "function") {
		try {
			ctx.effect(() => ctx.commands.register({
				name: "crew",
				description: "队友换脑与退役台：看名册与实际生效的模型/挡位、列可用模型与挡位、切队友模型（记忆保留）、退役与恢复",
				input: { hint: "list ｜ providers ｜ models <provider> ｜ set <队友> <模型> [挡位] ｜ retire <队友> [原因] ｜ restore <队友>" },
				handler: (invocation) => crewCommand(invocation),
			}), "team-crew.global-command()");
		} catch (error) {
			ctx.logger.error(`team-crew: global /crew registration failed: ${message(error)}`);
			note("the global /crew command could not be registered (see Host log); the panel reports itself");
		}
	}
	// ---------------------------------------------------------------- persistence
	let domain;
	/** The in-flight ledger open, so a tool call that arrives first still writes durably. */
	let openTask;
	function remember(record) {
		records.set(record.key, record);
		byChild.set(record.childSessionId, record);
	}
	function forget(record) {
		records.delete(record.key);
		if (byChild.get(record.childSessionId) === record) byChild.delete(record.childSessionId);
	}
	/** Persist one record, keeping the in-memory mirror authoritative for reads. */
	async function persist(record) {
		remember(record);
		if (openTask !== void 0) try {
			await openTask;
		} catch {}
		if (domain === void 0) return false;
		try {
			await domain.table(TABLE_NAME).put(record.key, record);
			return true;
		} catch (error) {
			warn(`ledger write failed for "${record.key}": ${message(error)} — this change is in-memory only`);
			note("ledger write failed (see Host log); recent changes are memory-only");
			return false;
		}
	}
	async function erase(record) {
		forget(record);
		if (openTask !== void 0) try {
			await openTask;
		} catch {}
		if (domain === void 0) return false;
		try {
			await domain.table(TABLE_NAME).delete(record.key);
			return true;
		} catch (error) {
			warn(`ledger delete failed for "${record.key}": ${message(error)}`);
			return false;
		}
	}
	ctx.effect(() => {
		const facility = ctx.storageDomain;
		if (facility === void 0 || typeof facility.open !== "function") {
			note("ledger storage is absent: retirements and model switches do NOT survive a restart");
			ctx.logger.error("team-crew: no ctx.storageDomain facility; plugin state is memory-only and lost on restart");
			return;
		}
		let attempt = 0;
		const retry = () => new Promise((settle) => setTimeout(settle, 250));
		const openAgain = async () => {
			for (; attempt < 6; attempt++) {
				try {
					const opened = await facility.open(crewLedger);
					domain = opened;
					for (const [, record] of opened.table(TABLE_NAME).entries()) remember(record);
					ctx.logger.info(`team-crew: ledger open, ${records.size} recorded teammate change(s)`);
					return;
				} catch (error) {
					// A plugin reload can briefly overlap the previous fiber's still
					// closing domain; that one is worth retrying, anything else is not.
					if (error?.code !== "already-open" || attempt === 5) {
						note(`ledger could not be opened (${message(error)}): retirements and model switches do NOT survive a restart`);
						ctx.logger.error(`team-crew: ledger open failed: ${message(error)}`);
						return;
					}
					await retry();
				}
			}
		};
		openTask = openAgain();
		return async () => {
			try {
				await openTask;
			} catch {}
			const closing = domain;
			domain = void 0;
			if (closing !== void 0) try {
				await closing.close();
			} catch (error) {
				warn(`ledger close failed: ${message(error)}`);
			}
		};
	}, "team-crew.ledger()");
	// ---------------------------------------------------------------- selection
	/**
	 * Get or install the plugin's model-selection shim for one live teammate.
	 *
	 * The shim is the platform's own seam: it drives the prompt-assembly
	 * variables, the `agent/request` route override, and the durable
	 * `[model changed]` notice, so a switch here behaves like a GUI model pick
	 * instead of a private side channel.
	 */
	function selectionFor(agent) {
		const existing = selections.get(agent.id);
		if (existing?.agent === agent) return existing;
		if (!canSelect) return void 0;
		const ref = {
			current: void 0,
			assembled: void 0
		};
		try {
			const dispose = installModelSelection(agent.ctx, ref);
			// Two owners for an agent-scoped registration (Harness plugin practice): the
			// Agent's own context unwinds it at disposal, and this plugin keeps the
			// disposer too, so unloading the plugin removes it without touching the Agent.
			let owner;
			try {
				owner = agent.ctx.effect(() => dispose);
			} catch (error) {
				warn(`agent.ctx.effect ownership failed for "${agent.id}", using the raw disposer: ${message(error)}`);
			}
			const entry = {
				agent,
				ref,
				dispose: () => {
					selections.delete(agent.id);
					if (owner !== void 0) owner();
					else dispose();
				}
			};
			selections.set(agent.id, entry);
			return entry;
		} catch (error) {
			warn(`installModelSelection failed for teammate "${agent.id}": ${message(error)}`);
			note("the model-selection shim could not be installed (see Host log); switches cannot take effect");
			return void 0;
		}
	}
	/** Commit one route onto a live teammate agent. */
	function performSwitch(agent, route) {
		const entry = selectionFor(agent);
		if (entry === void 0) return false;
		const selection = {
			provider: route.provider,
			model: route.model,
			...route.effort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(route.effort) }
		};
		entry.ref.current = selection;
		// Keep the REPORTED route truthful for consumers that read `agent.options`
		// (the roster `model` field, image-capability gating, delegation
		// inheritance). Best effort: a frozen options object is not fatal, because
		// the selection seam owns the actual routing and the roster rewrite below
		// still reports the effective model.
		try {
			const options = agent.options;
			if (options !== void 0) {
				options.provider = selection.provider;
				options.model = selection.model;
				if (selection.reasoningEffort === void 0) delete options.reasoningEffort;
				else options.reasoningEffort = selection.reasoningEffort;
			}
		} catch (error) {
			warn(`could not sync reported options for "${agent.id}" (roster display falls back to the ledger): ${message(error)}`);
		}
		// Durable intent in the teammate's OWN session log, through the platform's
		// existing log-only event type (never a new one).
		try {
			agent.session.append("model/selection", selection);
		} catch (error) {
			warn(`could not append model/selection for "${agent.id}": ${message(error)}`);
		}
		return true;
	}
	/**
	 * Apply one switch to a teammate agent, synchronously.
	 *
	 * Deliberately non-blocking: `agent/created` listeners hold the child's queued
	 * input until they settle, so an activation path must never await storage.
	 * @returns `applied` when the route is in effect from her next request.
	 */
	function switchNow(agent, record) {
		if (agent === void 0 || record.model === void 0) return "pending";
		if (resolved.deferModelSwitchWhileRunning && agent.status === "running") return "pending";
		if (!performSwitch(agent, record)) return record.switchState ?? "pending";
		if (record.switchState === "applied") return "applied";
		record.switchState = "applied";
		record.switchUpdatedAt = Date.now();
		return "applied";
	}
	/** Write the applied state down; failures are logged, never swallowed. */
	function recordApplied(record) {
		return persist({
			...record,
			switchState: "applied",
			switchUpdatedAt: Date.now()
		}).then((persisted) => persisted, (error) => {
			warn(`applied-switch write failed for "${record.memberName}": ${message(error)}`);
			return false;
		});
	}
	// ---------------------------------------------------------------- roster reads
	function membershipOf(agent) {
		if (agent === void 0) return void 0;
		try {
			return ctx.agentTeams.tryMembership(agent);
		} catch (error) {
			warn(`tryMembership threw: ${message(error)}`);
			return void 0;
		}
	}
	/**
	 * Resolve the caller's Lead identity plus one teammate roster row by name.
	 * @throws when the caller is not a Lead, or the name is not a usable teammate.
	 */
	function requireTeammate(caller, rawTarget) {
		let membership;
		try {
			membership = ctx.agentTeams.membership(caller);
		} catch (error) {
			throw new Error(`team-crew could not resolve this caller's Team: ${message(error)}`);
		}
		if (membership.role !== "lead") throw new Error("only the Team Lead may use this tool");
		const name = String(rawTarget ?? "").trim();
		if (name.length === 0) throw new Error("target must be a non-empty teammate name");
		const member = ctx.agentTeams.listMembers(caller).find((row) => row.role === "teammate" && row.name === name);
		if (member === void 0) throw new Error(`"${name}" is not an addressable teammate of this Team (the Lead is not a teammate, and a never-spawned name does not exist)`);
		if (member.status === "provisioning") throw new Error(`teammate "${name}" is still provisioning; try again once she reports inactive or running`);
		return {
			membership,
			member,
			name,
			record: () => records.get(keyOf(membership.root.id, name))
		};
	}
	/** The route this teammate is currently on, as far as it is knowable. */
	async function effectiveRoute(agent, member, record) {
		if (record?.model !== void 0) return {
			provider: record.provider,
			model: record.model,
			effort: record.effort
		};
		const live = routeOf(agent);
		if (live.provider !== void 0 || live.model !== void 0) return live;
		// A cold teammate's roster row falls back to the LEAD's model, which is not
		// her route; her own frozen descriptor is the only truthful answer there.
		if (agent === void 0) {
			const fromLog = await descriptorRoute(ctx, member.id);
			if (fromLog.model !== void 0 || fromLog.provider !== void 0) return fromLog;
		}
		return { ...member.model === void 0 ? {} : { model: member.model } };
	}
	/** Best-effort model catalog for one provider route. */
	async function catalog(provider) {
		const models = await ctx.llm.listModels(provider);
		return models.map((info) => ({
			provider,
			model: info.id,
			...info.name === void 0 ? {} : { name: info.name },
			...info.inputModalities === void 0 ? {} : { image_input: info.inputModalities.includes("image") }
		})).slice(0, CATALOG_HINT_LIMIT);
	}
	/** Registered providers whose adapter advertises this exact model id. */
	async function providersOffering(model, signal) {
		const providers = typeof ctx.llm.listProviders === "function" ? ctx.llm.listProviders() : [];
		const hits = [];
		// Bounded and cancellable: this only enriches an error message, so a typo
		// must not turn into a long stall across every registered adapter.
		for (const info of providers.slice(0, 16)) {
			if (signal?.aborted) break;
			const provider = typeof info?.id === "string" ? info.id : typeof info?.provider === "string" ? info.provider : void 0;
			if (provider === void 0) continue;
			try {
				const models = await ctx.llm.listModels(provider);
				if (models.some((entry) => entry.id === model)) hits.push(provider);
			} catch (error) {
				warn(`model discovery on provider "${provider}" failed: ${message(error)}`);
			}
		}
		return hits;
	}
	/** Supported efforts for one exact route, when the adapter exposes them. */
	async function effortsFor(provider, model) {
		try {
			const info = await ctx.llm.resolveModelInfo(provider, model);
			const efforts = info?.reasoning?.efforts;
			return Array.isArray(efforts) ? efforts.map((effort) => String(effort.id)) : [];
		} catch {
			return [];
		}
	}
	// ---------------------------------------------------------------- shared operations
	/** Provider routes with a registered adapter (catalog surface for panel and command). */
	function providerRoutes() {
		const listed = typeof ctx.llm.listProviders === "function" ? ctx.llm.listProviders() : [];
		return listed.filter((info) => typeof info?.id === "string").map((info) => ({
			id: info.id,
			name: typeof info.name === "string" ? info.name : info.id
		}));
	}
	/** One provider's models, each with the efforts its adapter advertises. */
	async function modelsFor(provider, signal) {
		const listed = typeof ctx.llm.listModels === "function" ? await ctx.llm.listModels(provider) : [];
		const out = [];
		for (const info of listed.slice(0, 60)) {
			if (signal?.aborted) break;
			out.push({
				provider,
				model: info.id,
				name: typeof info.name === "string" ? info.name : info.id,
				efforts: await effortsFor(provider, info.id),
				...info.inputModalities === void 0 ? {} : { image_input: info.inputModalities.includes("image") }
			});
		}
		return out;
	}
	/**
	 * The one snapshot every surface reads: the durable roster row, the effective
	 * route (ledger first, then the live Agent), and the plugin's own verdict on
	 * retirement and queued switches. Reading the same `records` map is what keeps
	 * the panel, `/crew`, and `list_agents` from ever disagreeing.
	 */
	function snapshot(caller) {
		const membership = ctx.agentTeams.membership(caller);
		if (membership.role !== "lead") throw new Error("only the Team Lead may use this");
		const members = [];
		for (const row of ctx.agentTeams.listMembers(caller)) {
			if (row.role !== "teammate") continue;
			const record = records.get(keyOf(membership.root.id, row.name));
			const agent = ctx.agents.get(row.id);
			const route = record?.model === void 0 ? routeOf(agent) : {
				provider: record.provider,
				model: record.model,
				reasoningEffort: record.effort
			};
			members.push({
				name: row.name,
				child_session_id: String(row.id),
				status: row.status,
				resident: agent !== void 0,
				provider: typeof route.provider === "string" ? route.provider : null,
				model: typeof route.model === "string" ? route.model : row.model ?? null,
				reasoning_effort: typeof route.reasoningEffort === "string" ? route.reasoningEffort : null,
				retired: record?.retired === true,
				switch_state: record?.switchState ?? null,
				...record?.retireReason === void 0 ? {} : { retire_reason: record.retireReason },
				...row.description === void 0 ? {} : { description: row.description }
			});
		}
		return {
			ok: true,
			lead: String(membership.root.id),
			members,
			providers: providerRoutes(),
			warnings: [...notes]
		};
	}
	/** Grammar shared by the composer command and the GUI panel. */
	const CREW_USAGE = [
		"/crew list — 名册 + 每人当前生效的模型/挡位",
		"/crew providers — 已注册的 provider 路线",
		"/crew models <provider> — 该 provider 的模型与各模型支持的挡位",
		"/crew set <队友> <模型|provider/模型> [挡位] — 换脑，记忆保留",
		"/crew retire <队友> [原因] — 退役（名册隐藏 + 拒绝投递）",
		"/crew restore <队友> — 撤销退役，同一个她回来"
	];
	/** Split a command line; double quotes carry names with spaces. */
	function tokenize(line) {
		const out = [];
		const pattern = /"([^"]*)"|([^\s]+)/g;
		let match;
		while ((match = pattern.exec(line)) !== null) out.push(match[1] !== void 0 ? match[1] : match[2]);
		return out;
	}
	/**
	 * One operation, two human callers: the `/crew` composer line and the panel
	 * button both land here, and each sub-command delegates to the very same
	 * functions the model-facing tools call.
	 */
	async function crewCommand(invocation) {
		const parts = tokenize(String(invocation.rawInput ?? "").trim());
		const sub = (parts[0] ?? "list").toLowerCase();
		const ok = (value) => ({
			kind: "success",
			text: JSON.stringify(value)
		});
		const fail = (text) => ({
			kind: "error",
			text
		});
		const exec = { signal: invocation.signal };
		try {
			if (sub === "list" || sub === "status") return ok(snapshot(invocation.agent));
			if (sub === "providers") return ok({
				ok: true,
				providers: providerRoutes()
			});
			if (sub === "models") {
				if (typeof parts[1] !== "string" || parts[1].length === 0) return fail("用法：/crew models <provider>（先 /crew providers）");
				return ok({
					ok: true,
					provider: parts[1],
					models: await modelsFor(parts[1], invocation.signal)
				});
			}
			if (sub === "set") {
				if (parts.length < 3) return fail("用法：/crew set <队友> <模型|provider/模型> [挡位]");
				return ok(await setModel(invocation.agent, {
					target: parts[1],
					model: parts[2],
					...parts[3] === void 0 ? {} : { reasoning_effort: parts[3] }
				}, exec));
			}
			if (sub === "retire" || sub === "restore") {
				if (parts.length < 2) return fail(`用法：/crew ${sub} <队友>${sub === "retire" ? " [原因]" : ""}`);
				const args = {
					target: parts[1],
					action: sub === "retire" ? "retire" : "restore"
				};
				if (sub === "retire" && parts.length > 2) args.reason = parts.slice(2).join(" ");
				return ok(await retire(invocation.agent, args, exec));
			}
			if (sub === "help" || sub === "usage") return ok({
				ok: true,
				usage: CREW_USAGE
			});
			return fail(`未知子命令 "${sub}"。${CREW_USAGE.join(" ｜ ")}`);
		} catch (error) {
			return fail(message(error));
		}
	}
	// ---------------------------------------------------------------- F1
	async function setModel(caller, args, exec) {
		if (!usable) throw new Error(`team-crew is degraded and cannot switch models: ${notes.join("; ") || "a required service is missing"}`);
		const { membership, member, name: target, record } = requireTeammate(caller, args.target);
		const existing = record();
		const agent = ctx.agents.get(member.id);
		const current = await effectiveRoute(agent, member, existing);
		if (args.list_models === true) {
			const provider = text(args.provider, 128) ?? current.provider;
			if (provider === void 0) throw new Error("list_models needs a `provider` (this teammate has no known provider yet; pass provider: \"...\")");
			return {
				target,
				state: "unchanged",
				previous: routeValue(current),
				selected: routeValue(current),
				context: "unchanged",
				persisted: domain !== void 0,
				note: `Model catalog for provider "${provider}" (nothing was changed).${notes.length > 0 ? ` NOTE: ${notes.join("; ")}` : ""}`,
				models: await catalog(provider)
			};
		}
		if (existing?.retired === true) throw new Error(`teammate "${target}" is retired${existing.retireReason === void 0 ? "" : ` (${existing.retireReason})`}; run retire_teammate with action "restore" before switching her model`);
		let provider = text(args.provider, 128);
		let model = text(args.model, 256);
		if (model !== void 0 && provider === void 0 && model.includes("/")) {
			const split = model.indexOf("/");
			const head = model.slice(0, split).trim();
			const tail = model.slice(split + 1).trim();
			if (head.length > 0 && tail.length > 0) {
				provider = head;
				model = tail;
			}
		}
		const effort = text(args.reasoning_effort, 64);
		if (model === void 0) model = current.model;
		if (provider === void 0) provider = current.provider;
		if (model === void 0) throw new Error("no model is known for this teammate — pass both `provider` and `model`");
		if (provider === void 0) throw new Error(`pass a \`provider\` too: this teammate's route is unknown${current.model === void 0 ? "" : ` (model "${current.model}")`}`);
		const routeUnchanged = provider === current.provider && model === current.model;
		const nextEffort = effort ?? (routeUnchanged ? current.effort ?? current.reasoningEffort : void 0);
		const chosen = {
			provider,
			model,
			...nextEffort === void 0 ? {} : { effort: nextEffort }
		};
		let validated;
		try {
			validated = await ctx.llm.resolveCallConfig({
				provider: chosen.provider,
				model: chosen.model,
				...chosen.effort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(chosen.effort) }
			}, exec.signal);
		} catch (error) {
			const hints = [];
			if (routeUnchanged) {
				// The route itself is her current one, so the rejection is about the effort.
				const efforts = await effortsFor(chosen.provider, chosen.model);
				if (efforts.length > 0) hints.push(`"${chosen.model}" supports efforts: ${efforts.join(", ")}`);
			} else {
				const offering = await providersOffering(chosen.model).catch(() => []);
				if (offering.length > 0) hints.push(`providers advertising "${chosen.model}": ${offering.join(", ")}`);
			}
			let known = [];
			try {
				known = await catalog(chosen.provider);
			} catch {}
			throw new Error(`"${chosen.provider}/${chosen.model}"${chosen.effort === void 0 ? "" : ` with effort "${chosen.effort}"`} was rejected: ${message(error)}${hints.length > 0 ? ` (${hints.join("; ")})` : ""}${known.length > 0 ? ` — this provider advertises: ${known.map((info) => info.model).join(", ")}` : ""}`);
		}
		const final = {
			provider: typeof validated?.provider === "string" ? validated.provider : chosen.provider,
			model: typeof validated?.model === "string" ? validated.model : chosen.model,
			...typeof validated?.reasoningEffort === "string" ? { effort: validated.reasoningEffort } : {}
		};
		const noop = sameRoute(final, existing ?? {}) && existing?.switchState !== void 0;
		const base = {
			key: keyOf(membership.root.id, target),
			rootSessionId: String(membership.root.id),
			memberName: target,
			childSessionId: String(member.id),
			retired: existing?.retired === true,
			...existing?.retiredAt === void 0 ? {} : { retiredAt: existing.retiredAt },
			...existing?.retireReason === void 0 ? {} : { retireReason: existing.retireReason },
			provider: final.provider,
			model: final.model,
			...final.effort === void 0 ? {} : { effort: final.effort },
			switchState: noop && existing?.switchState === "applied" ? "applied" : "pending",
			switchUpdatedAt: Date.now()
		};
		if (!noop) await persist(base);
		const state = switchNow(agent, base);
		const persisted = state === "applied" ? await recordApplied(base) : domain !== void 0;
		return {
			target,
			state,
			previous: routeValue(current),
			selected: routeValue(final),
			context: "retained",
			persisted,
			note: [
				noop ? "She is already on this exact route; nothing was rewritten." : "",
				state === "applied" ? `From her next request she runs on ${final.provider}/${final.model}${final.effort === void 0 ? "" : ` (effort ${final.effort})`}. Her memory is intact; she will see one [model changed] notice in context.` : `Queued: ${final.provider}/${final.model}${final.effort === void 0 ? "" : ` (effort ${final.effort})`}. She is mid-turn or not resident in this process, so her current turn finishes on the old model and the new route starts at her next turn gap or activation.`,
				domain === void 0 ? "WARNING: the ledger is unavailable, so this switch is lost on restart." : "",
				...notes
			].filter((part) => part.length > 0).join(" ")
		};
	}
	// ---------------------------------------------------------------- F2
	async function retire(caller, args, exec) {
		if (!usable) throw new Error(`team-crew is degraded and cannot retire members: ${notes.join("; ") || "a required service is missing"}`);
		const action = args.action ?? "retire";
		const { membership, member, name: target, record } = requireTeammate(caller, args.target);
		const existing = record();
		const agent = ctx.agents.get(member.id);
		if (action === "restore") {
			if (existing?.retired !== true) return {
				target,
				action: "not-retired",
				...agent === void 0 ? {} : { wasRunning: agent.status === "running" },
				persisted: existing !== void 0 && domain !== void 0,
				note: `"${target}" was not retired, so nothing changed.${existing === void 0 ? "" : " Her recorded model route is untouched."}${notes.length > 0 ? ` NOTE: ${notes.join("; ")}` : ""}`
			};
			if (existing.model === void 0) await erase(existing);
			else await persist({
				...existing,
				retired: false
			});
			return {
				target,
				action: "restored",
				persisted: domain !== void 0,
				note: `"${target}" is back in the roster and reachable again${agent === void 0 ? " (she is cold, so the next send_message cold-resumes her session with its memory intact)" : ""}.${notes.length > 0 ? ` NOTE: ${notes.join("; ")}` : ""}`
			};
		}
		if (existing?.retired === true) return {
			target,
			action: "already-retired",
			persisted: true,
			note: `"${target}" is already retired${existing.retireReason === void 0 ? "" : ` (${existing.retireReason})`}. Use action "restore" to bring her back.`
		};
		const reason = text(args.reason, 500);
		const entry = {
			key: keyOf(membership.root.id, target),
			rootSessionId: String(membership.root.id),
			memberName: target,
			childSessionId: String(member.id),
			retired: true,
			retiredAt: Date.now(),
			...reason === void 0 ? {} : { retireReason: reason },
			...existing?.provider === void 0 ? {} : { provider: existing.provider },
			...existing?.model === void 0 ? {} : { model: existing.model },
			...existing?.effort === void 0 ? {} : { effort: existing.effort },
			...existing?.switchState === void 0 ? {} : { switchState: existing.switchState }
		};
		await persist(entry);
		const wasRunning = agent?.status === "running";
		let released = false;
		let releaseNote = "";
		const shouldRelease = args.release ?? resolved.drainOnRetire;
		if (agent === void 0) releaseNote = "She had no live activation in this process, so nothing needed releasing; her persisted session stays on disk.";
		else if (!shouldRelease) releaseNote = "Kept resident as requested (`release: false`); delivery to her is still refused.";
		else if (!canRelease) releaseNote = "Activation release is unavailable in this deployment: her live child stays resident until the Lead session tears down. Delivery is still refused.";
		else {
			try {
				await withTimeout(ctx.subagents.drainContinuableChildren(membership.root, [member.id]), DRAIN_TIMEOUT_MS, exec.signal);
				released = true;
				releaseNote = `Her live activation was released${wasRunning ? " (an active turn was interrupted)" : ""}; the session log stays on disk, so "restore" or a fresh spawn can still read it.`;
			} catch (error) {
				releaseNote = `Activation release did not settle (${message(error)}); she may stay resident until the Lead session tears down. Delivery is still refused.`;
				warn(releaseNote);
			}
		}
		return {
			target,
			action: "retired",
			wasRunning,
			released,
			persisted: domain !== void 0,
			note: [
				`"${target}" is retired: hidden from list_agents, and send_message / interrupt_agent / task reassignment aimed at her are refused.`,
				releaseNote,
				"The durable Team journal is never rewritten, so the browser roster panel may still show her row; the model-facing roster is what routing follows.",
				domain === void 0 ? "WARNING: the ledger is unavailable, so this retirement is lost on restart." : "",
				...notes
			].filter((part) => part.length > 0).join(" ")
		};
	}
	// ---------------------------------------------------------------- enforcement
	if (canDeny) {
		const routed = new Set([
			"send_message",
			"interrupt_agent",
			"team_task_update"
		]);
		try {
			ctx.effect(() => ctx.tools.guard((execution) => {
				try {
					if (records.size === 0) return void 0;
					const args = execution.arguments;
					if (args === null || typeof args !== "object") return void 0;
					const caller = execution.agent;
					if (routed.has(execution.name)) {
						const candidate = execution.name === "team_task_update" ? args.action === "reassign" ? args.owner : void 0 : args.target;
						if (typeof candidate === "string" && candidate.length > 0) {
							const root = membershipOf(caller);
							const record = root === void 0 ? void 0 : records.get(keyOf(root.root.id, candidate.trim()));
							if (record?.retired === true) return `TEAM_MEMBER_RETIRED: teammate "${candidate.trim()}" was retired by retire_teammate${record.retireReason === void 0 ? "" : ` (${record.retireReason})`} and is deliberately absent from list_agents. Do not retry. Use retire_teammate with action "restore" to bring her back, or spawn_teammate a new member.`;
						}
					}
					if (execution.name === "send_message" && caller !== void 0) {
						const own = byChild.get(caller.id);
						if (own?.retired === true) return `TEAM_MEMBER_RETIRED: you ("${own.memberName}") were retired by the Team Lead${own.retireReason === void 0 ? "" : ` (${own.retireReason})`} and can no longer deliver messages. Stop here and do not retry.`;
					}
				} catch (error) {
					warn(`guard check failed; the call was allowed rather than blocked: ${message(error)}`);
				}
				return void 0;
			}), "team-crew.guard()");
		} catch (error) {
			ctx.logger.error(`team-crew: tools.guard registration failed, so retirement does NOT refuse delivery: ${message(error)}`);
			note("the tool guard could not be registered: retired members can still be messaged");
		}
	} else if (usable) note("the tool guard is unavailable, so retirement cannot refuse delivery");
	if (canRewrite) {
		try {
			ctx.effect(() => ctx.on("tools/post-execute", async (execution, result, next) => {
				const decision = await next();
				if (execution.name !== "list_agents" || records.size === 0 || decision.kind === "block") return decision;
				try {
					if (result.isError === true) return decision;
					const value = decision.value ?? result.value;
					if (!Array.isArray(value)) return decision;
					const root = membershipOf(execution.agent);
					if (root === void 0) return decision;
					let changed = false;
					const rows = [];
					for (const row of value) {
						if (row === null || typeof row !== "object" || row.role !== "teammate" || typeof row.target !== "string") {
							rows.push(row);
							continue;
						}
						const record = records.get(keyOf(root.root.id, row.target));
						if (record === void 0) {
							rows.push(row);
							continue;
						}
						if (record.retired === true) {
							changed = true;
							continue;
						}
						const diagnostics = [...row.diagnostics ?? []];
						const route = `${record.provider}/${record.model}`;
						const effort = record.effort === void 0 ? "" : ` (effort ${record.effort})`;
						if (record.model !== void 0 && row.model !== record.model) {
							changed = true;
							diagnostics.push(record.switchState === "pending" ? `queued model switch to ${route}${effort}: takes effect at her next turn gap or activation` : `model route ${route}${effort}: switched by set_teammate_model, memory retained`);
							rows.push({
								...row,
								model: record.model,
								diagnostics
							});
							continue;
						}
						if (record.switchState === "pending") {
							changed = true;
							rows.push({
								...row,
								diagnostics: [...diagnostics, `switch to ${route}${effort} queued: applies at her next turn gap or activation`]
							});
							continue;
						}
						rows.push(row);
					}
					if (!changed) return decision;
					return {
						kind: "accept",
						value: rows,
						...decision.additionalContexts === void 0 ? {} : { additionalContexts: decision.additionalContexts }
					};
				} catch (error) {
					warn(`roster rewrite failed; the original roster was returned: ${message(error)}`);
					return decision;
				}
			}), "team-crew.roster-rewrite()");
		} catch (error) {
			ctx.logger.error(`team-crew: tools/post-execute listener registration failed, so the roster cannot be rewritten: ${message(error)}`);
			note("the post-execute listener could not be registered: the roster will not reflect switches or retirements");
		}
	}
	// ---------------------------------------------------------------- lifecycle
	/** Re-apply a queued switch the moment a teammate's turn ends. */
	function observeStatus(payload) {
		try {
			if (payload.status !== "idle") return;
			const record = byChild.get(payload.agent.id);
			if (record === void 0 || record.model === void 0 || record.retired === true) return;
			if (record.switchState === "applied" && routeOf(payload.agent).model === record.model) return;
			if (switchNow(payload.agent, record) !== "applied") return;
			void recordApplied(record);
			ctx.logger.info(`team-crew: queued switch for "${record.memberName}" applied at the turn gap (${record.provider}/${record.model})`);
		} catch (error) {
			warn(`status observer failed: ${message(error)}`);
		}
	}
	const installed = new Map();
	function maybeInstall(agent) {
		if (installed.has(agent)) return;
		const membership = membershipOf(agent);
		if (membership?.role !== "lead") return;
		try {
			installed.set(agent, install(agent, ctx, {
				setModel,
				retire,
				crewCommand
			}));
		} catch (error) {
			ctx.logger.error(`team-crew: could not install crew tools in lead scope "${agent.id}": ${message(error)}`);
			note("crew tools could not be registered in one Lead scope (see Host log)");
		}
	}
	if (usable) {
		for (const agent of ctx.agents.list()) maybeInstall(agent);
		ctx.effect(() => ctx.on("agent/created", ({ agent }) => {
			maybeInstall(agent);
			const record = byChild.get(agent.id);
			if (record === void 0 || record.model === void 0) return;
			if (record.retired === true) {
				warn(`retired teammate "${record.memberName}" was activated in this process; delivery stays refused by the tool guard`);
				return;
			}
			// Never await here: `agent/created` listeners hold this child's queued
			// input, and a slow storage write would delay (or fail) her activation.
			const state = switchNow(agent, record);
			if (state === "applied") void recordApplied(record);
			ctx.logger.info(`team-crew: activation of "${record.memberName}" runs on ${record.provider}/${record.model} (state: ${state})`);
		}), "team-crew.agent-created()");
		ctx.effect(() => ctx.on("agent/disposed", ({ agent }) => {
			installed.get(agent)?.();
			installed.delete(agent);
			const entry = selections.get(agent.id);
			if (entry === void 0) return;
			selections.delete(agent.id);
			try {
				entry.dispose();
			} catch (error) {
				warn(`selection disposer failed for "${agent.id}": ${message(error)}`);
			}
		}), "team-crew.agent-disposed()");
		ctx.effect(() => ctx.on("agent/status", observeStatus), "team-crew.agent-status()");
	}
	ctx.effect(() => () => {
		for (const dispose of installed.values()) try {
			dispose();
		} catch {}
		installed.clear();
		for (const entry of selections.values()) try {
			entry.dispose();
		} catch {}
		selections.clear();
	}, "team-crew.scoped()");
	if (usable) {
		if (notes.length > 0) ctx.logger.error(`team-crew ACTIVE WITH DEGRADATIONS: ${notes.join("; ")}`);
		else ctx.logger.info("team-crew: set_teammate_model + retire_teammate available in Team Lead scopes");
	} else ctx.logger.error(`team-crew INACTIVE: ${notes.join("; ")}`);
}
