/**
 * @local/dsh-team-crew — Client half: the Team Crew desk.
 *
 * A conversation-header action that lets the human switch a teammate's model and
 * reasoning effort, and retire or restore her, without going through the agent.
 *
 * It owns no logic: every action is one `/crew` command line dispatched through
 * the same human-command surface the composer uses, which calls the same Host
 * operations as `set_teammate_model` / `retire_teammate`. The roster comes from
 * the shared Session store's `agentTeam` projection, so the button appears only
 * in a session that actually has teammates — and costs no request at all.
 *
 * Styles use only `--dsw-alias-*` theme tokens; `react` comes from the browser
 * module table, and no Harness Client package is imported.
 */
window.__ModuleLoader__.load({
  id: "@local/dsh-team-crew",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const NS = "team-crew";
    const DICTIONARY = {
      zh: {
        button: "队友",
        title: "队友换脑台",
        loading: "读取中…",
        refresh: "刷新",
        close: "关闭",
        apply: "应用",
        retiring: "退役",
        restore: "恢复",
        provider: "provider",
        model: "模型",
        effort: "挡位",
        defaultEffort: "（默认）",
        retired: "已退役",
        queued: "排队中",
        cold: "冷",
        running: "在跑",
        current: "现在",
        note: "提示",
        needModel: "先选一个模型。",
        unchanged: "模型和挡位都没变。",
        failed: "操作失败",
        retireReason: "GUI 换脑台退役",
        help: "命令栏同样能用了：/crew list ｜ /crew models <provider> ｜ /crew set <队友> <模型> [挡位] ｜ /crew retire <队友>"
      },
      en: {
        button: "Teammates",
        title: "Teammate model desk",
        loading: "loading…",
        refresh: "Refresh",
        close: "Close",
        apply: "Apply",
        retiring: "Retire",
        restore: "Restore",
        provider: "provider",
        model: "model",
        effort: "effort",
        defaultEffort: "(default)",
        retired: "retired",
        queued: "queued",
        cold: "cold",
        running: "running",
        current: "now",
        note: "note",
        needModel: "Pick a model first.",
        unchanged: "Neither model nor effort changed.",
        failed: "Operation failed",
        retireReason: "Retired from the Team Crew desk",
        help: "Composer works too: /crew list ｜ /crew models <provider> ｜ /crew set <mate> <model> [effort] ｜ /crew retire <mate>"
      }
    };
    const CSS = `
.tc-wrap{position:relative;display:inline-flex}
.tc-chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.tc-chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.tc-card{position:absolute;top:calc(100% + 6px);right:0;z-index:30;width:480px;max-width:88vw;display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12px;box-shadow:0 12px 32px rgba(0,0,0,.28)}
.tc-head{display:flex;align-items:center;gap:8px}
.tc-head b{font-size:13px;font-weight:600;flex:1}
.tc-ghost{height:24px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.tc-ghost:hover{color:var(--dsw-alias-label-primary)}
.tc-row{display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.tc-row[data-retired="1"]{opacity:.72;border-style:dashed}
.tc-line{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.tc-name{font-weight:600}
.tc-spacer{flex:1}
.tc-tag{padding:0 6px;border-radius:8px;font-size:11px;line-height:18px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.tc-tag[data-kind="retired"]{color:var(--dsw-alias-state-error-primary);border-color:currentColor}
.tc-tag[data-kind="queued"]{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}
.tc-tag[data-kind="run"]{color:var(--dsw-alias-state-success-primary)}
.tc-field{display:flex;align-items:center;gap:4px}
.tc-field span{color:var(--dsw-alias-label-secondary);font-size:11px}
.tc-field select{height:24px;max-width:170px;border-radius:6px;padding:0 4px;font-size:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:inherit}
.tc-apply{height:24px;padding:0 10px;border-radius:6px;border:none;cursor:pointer;font-size:12px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.tc-apply:disabled{opacity:.5;cursor:default}
.tc-msg{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;word-break:break-word}
.tc-msg[data-kind="error"]{color:var(--dsw-alias-state-error-primary)}
`;
    /**
     * Liquid-glass adaptation for the wallpaper-engine theme. When that plugin
     * is active it sets `body[data-we-wallpaper]` and publishes the shared glass
     * recipe tokens (--we-glass-alpha / --we-blur / --we-saturate /
     * --we-surface-tint-rgb-light|dark / --we-glass-highlight / --we-glass-shadow
     * / --we-readability-floor, see its lib/client.js "iOS liquid glass" block).
     * We reuse EXACTLY those tokens so the desk reads as the same wet glass as
     * the composer and popovers; without the plugin the variables simply do not
     * resolve and the base theme-token styling above stays authoritative.
     * Mirrors its safety rules: light uses the raw alpha, dark multiplies by 0.4;
     * a readability floor keeps text ≥ 4.5:1; no backdrop-filter support ⇒
     * near-opaque tinted plate instead (its detectSoftwareRender equivalent).
     */
    const GLASS_CSS = `
body[data-we-wallpaper] .tc-chip{
  background:color-mix(in srgb, rgba(var(--we-surface-tint-rgb-light,255,255,255), var(--we-glass-alpha,.15)) calc((1 - var(--we-readability-floor,0)) * 100%), var(--dsw-alias-bg-layer-1));
  border-color:rgba(255,255,255,var(--we-glass-highlight,.32))}
body[data-ds-dark-theme][data-we-wallpaper] .tc-chip{
  background:color-mix(in srgb, rgba(var(--we-surface-tint-rgb-dark,255,255,255), calc(var(--we-glass-alpha,.15) * .4)) calc((1 - var(--we-readability-floor,0)) * 100%), var(--dsw-alias-bg-layer-1))}
body[data-we-wallpaper] .tc-card{
  background:color-mix(in srgb, rgba(var(--we-surface-tint-rgb-light,255,255,255), calc(var(--we-glass-alpha,.15) * .8)) calc((1 - var(--we-readability-floor,0)) * 100%), var(--dsw-alias-bg-overlay));
  -webkit-backdrop-filter:blur(var(--we-blur,16px)) saturate(var(--we-saturate,1.8)) brightness(var(--we-glass-brightness,1.04)) contrast(1.01);
  backdrop-filter:blur(var(--we-blur,16px)) saturate(var(--we-saturate,1.8)) brightness(var(--we-glass-brightness,1.04)) contrast(1.01);
  border:1px solid rgba(255,255,255,var(--we-glass-highlight,.32));
  box-shadow:inset 0 1px 0 rgba(255,255,255,var(--we-glass-highlight,.32)),inset 0 -1px 0 rgba(255,255,255,calc(var(--we-glass-highlight,.32) * .35)),0 12px 40px rgba(0,0,0,var(--we-glass-shadow,.12))}
body[data-ds-dark-theme][data-we-wallpaper] .tc-card{
  background:color-mix(in srgb, rgba(var(--we-surface-tint-rgb-dark,255,255,255), calc(var(--we-glass-alpha,.15) * .33)) calc((1 - var(--we-readability-floor,0)) * 100%), var(--dsw-alias-bg-overlay))}
body[data-we-wallpaper] .tc-row{
  background:color-mix(in srgb, rgba(var(--we-surface-tint-rgb-light,255,255,255), calc(var(--we-glass-alpha,.15) * .6)) calc((1 - var(--we-readability-floor,0)) * 100%), transparent);
  border-color:rgba(255,255,255,calc(var(--we-glass-highlight,.32) * .5))}
body[data-ds-dark-theme][data-we-wallpaper] .tc-row{
  background:color-mix(in srgb, rgba(var(--we-surface-tint-rgb-dark,255,255,255), calc(var(--we-glass-alpha,.15) * .25)) calc((1 - var(--we-readability-floor,0)) * 100%), transparent)}
body[data-we-wallpaper] .tc-ghost{
  background:rgba(var(--we-surface-tint-rgb-light,255,255,255), calc(var(--we-glass-alpha,.15) * .8))}
body[data-ds-dark-theme][data-we-wallpaper] .tc-ghost{
  background:rgba(var(--we-surface-tint-rgb-dark,255,255,255), calc(var(--we-glass-alpha,.15) * .3))}
body[data-we-wallpaper] .tc-field select{
  background:color-mix(in srgb, rgba(var(--we-surface-tint-rgb-light,255,255,255), calc(var(--we-glass-alpha,.15) * 1.4)) calc((1 - var(--we-readability-floor,0)) * 100%), var(--dsw-alias-bg-layer-2))}
body[data-ds-dark-theme][data-we-wallpaper] .tc-field select{
  background:color-mix(in srgb, rgba(var(--we-surface-tint-rgb-dark,255,255,255), calc(var(--we-glass-alpha,.15) * .6)) calc((1 - var(--we-readability-floor,0)) * 100%), var(--dsw-alias-bg-layer-2))}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){
  body[data-we-wallpaper] .tc-card{
    background:color-mix(in srgb, var(--dsw-alias-bg-overlay) 92%, transparent);
    -webkit-backdrop-filter:none;backdrop-filter:none}}
`;
    /**
     * Provider catalogs rarely change within a page's life, and fetching one is a
     * read that would otherwise be logged as a command row on every open.
     */
    const catalogCache = new Map();
    /**
     * Unwrap one `/crew` execution. The gateway answers `RemoteResult` —
     * `{ok:true, value}` or `{ok:false, error}` (dsh-api-gateway README: every
     * unary call resolves to RemoteResult and never rejects for a carrier
     * problem) — where `value` is the settled `CommandExecution`
     * `{commandId, result}` or `undefined` for an admission miss (unknown name
     * / malformed line). The composer decodes in exactly this order
     * (dsh-client-ui-commands lib/client.js execute()): ok → value → result.
     * v1.1.2 bug: unwrap looked for `.result` on the ENVELOPE, found nothing,
     * and silently answered `{ok:true, note:""}` — the desk rendered empty rows
     * and dead buttons with no error shown.
     */
    function unwrap(outcome) {
      if (outcome !== null && typeof outcome === "object" && Object.hasOwn(outcome, "ok")) {
        if (outcome.ok !== true) {
          const failure = outcome.error;
          const error = new Error(failure !== null && typeof failure === "object" && typeof failure.message === "string" && failure.message.length > 0 ? failure.message : `remote call failed (${failure?.code ?? "unknown"})`);
          error.crewError = true;
          throw error;
        }
        outcome = outcome.value;
      }
      if (outcome === undefined || outcome === null) {
        const error = new Error("command was not admitted (unknown or malformed command)");
        error.crewError = true;
        throw error;
      }
      const result = outcome !== null && typeof outcome === "object" && Object.hasOwn(outcome, "result") ? outcome.result : outcome;
      const text = typeof result?.text === "string" ? result.text : "";
      let payload;
      try {
        payload = text.length > 0 ? JSON.parse(text) : void 0;
      } catch {
        payload = void 0;
      }
      if (result?.kind === "error") {
        const error = new Error(text.length > 0 ? text : "command failed");
        error.crewError = true;
        throw error;
      }
      if (payload !== void 0) return payload;
      return {
        ok: true,
        note: text
      };
    }
    function CrewDesk(props) {
      const ctx = props.ctx;
      const t = typeof props.t === "function" ? props.t : (key) => DICTIONARY.zh[key] ?? key;
      const sessionId = props.sessionId;
      const useSession = props.useSession;
      const useSessions = props.useSessions;
      // The roster is owned by the Lead Session; a teammate's own header resolves
      // up to the same one, so the desk works from either side of the conversation.
      const parent = useSession === undefined ? void 0 : useSession((snapshot) => snapshot.subagent?.address?.parentSessionId);
      const leadId = parent ?? sessionId;
      const roster = useSessions === undefined ? void 0 : useSessions((state) => state.projectionsBySession[leadId]?.values.agentTeam);
      const teammates = (roster?.members ?? []).filter((member) => member.role === "teammate");
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      const [view, setView] = React.useState(null);
      const [drafts, setDrafts] = React.useState({});
      const [catalogs, setCatalogs] = React.useState({});
      const run = async (line) => {
        setBusy(true);
        try {
          const payload = unwrap(await ctx.remote.commands.execute(leadId, line, []));
          setMessage(null);
          return payload;
        } catch (error) {
          setMessage({
            kind: "error",
            text: `${t("failed")}: ${String(error?.message ?? error)}`
          });
          return void 0;
        } finally {
          setBusy(false);
        }
      };
      const modelsFor = async (provider, force) => {
        if (provider === undefined || provider === null || provider === "") return [];
        if (!force && catalogCache.has(provider)) return catalogCache.get(provider);
        const listed = await run(`/crew models ${JSON.stringify(provider)}`);
        const models = Array.isArray(listed?.models) ? listed.models : [];
        catalogCache.set(provider, models);
        setCatalogs((current) => ({
          ...current,
          [provider]: models
        }));
        return models;
      };
      const refresh = async (force) => {
        const payload = await run("/crew list");
        if (payload === undefined) return;
        setView(payload);
        setDrafts({});
        for (const provider of new Set((payload.members ?? []).map((member) => member.provider).filter(Boolean))) await modelsFor(provider, force === true);
      };
      React.useEffect(() => {
        if (!open) return;
        void refresh(false);
      }, [open]);
      React.useEffect(() => {
        if (!open) return void 0;
        const onKey = (event) => {
          if (event.key === "Escape") setOpen(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [open]);
      // Nothing to manage: stay out of the header entirely.
      if (teammates.length === 0) return null;
      const rows = view?.members ?? teammates.map((member) => ({
        name: member.name,
        retired: false,
        provider: null,
        model: null,
        status: "inactive"
      }));
      return h("div", { className: "tc-wrap" }, h("style", { dangerouslySetInnerHTML: { __html: CSS + GLASS_CSS } }), h("button", {
        className: "tc-chip",
        type: "button",
        title: t("title"),
        "aria-expanded": open ? "true" : "false",
        onClick: () => setOpen((value) => !value)
      }, t("button"), h("span", { className: "tc-tag" }, teammates.length)), open ? h("div", {
        className: "tc-card",
        role: "dialog",
        "aria-label": t("title")
      }, h("div", { className: "tc-head" }, h("b", {}, t("title")), busy ? h("span", { className: "tc-msg" }, t("loading")) : null, h("button", {
        className: "tc-ghost",
        type: "button",
        disabled: busy,
        onClick: () => void refresh(true)
      }, t("refresh")), h("button", {
        className: "tc-ghost",
        type: "button",
        onClick: () => setOpen(false)
      }, t("close"))), message === null ? null : h("div", {
        className: "tc-msg",
        "data-kind": message.kind
      }, message.text), (view?.warnings ?? []).length === 0 ? null : h("div", { className: "tc-msg" }, `${t("note")}: ${view.warnings.join(" ; ")}`), rows.map((member) => {
        const draft = drafts[member.name] ?? {
          provider: member.provider ?? null,
          model: member.model ?? null,
          effort: member.reasoning_effort ?? null
        };
        const providerKey = draft.provider ?? member.provider;
        const models = catalogs[providerKey] ?? catalogCache.get(providerKey) ?? [];
        const chosen = models.find((entry) => entry.model === draft.model);
        const efforts = Array.isArray(chosen?.efforts) ? chosen.efforts : [];
        const dirty = (draft.model ?? null) !== (member.model ?? null) || (draft.effort ?? null) !== (member.reasoning_effort ?? null);
        const setDraft = (patch) => setDrafts((current) => ({
          ...current,
          [member.name]: {
            ...current[member.name],
            ...patch
          }
        }));
        return h("div", {
          className: "tc-row",
          key: member.name,
          "data-retired": member.retired === true ? "1" : "0"
        }, h("div", { className: "tc-line" }, h("span", { className: "tc-name" }, member.name), member.retired === true ? h("span", { className: "tc-tag", "data-kind": "retired" }, t("retired")) : null, member.switch_state === "pending" ? h("span", { className: "tc-tag", "data-kind": "queued" }, t("queued")) : null, member.resident === false ? h("span", { className: "tc-tag" }, t("cold")) : null, member.status === "running" ? h("span", { className: "tc-tag", "data-kind": "run" }, t("running")) : null, h("span", { className: "tc-spacer" }), h("span", { className: "tc-tag" }, `${t("current")}: ${[member.provider, member.model].filter(Boolean).join("/") || "?"}${member.reasoning_effort ? ` · ${member.reasoning_effort}` : ""}`)), h("div", { className: "tc-line" }, h("label", { className: "tc-field" }, h("span", {}, t("provider")), h("select", {
          value: draft.provider ?? "",
          disabled: member.retired === true,
          onChange: (event) => {
            setDraft({
              provider: event.target.value,
              model: null,
              effort: null
            });
            void modelsFor(event.target.value, false);
          }
        }, h("option", { value: "" }, "—"), (view?.providers ?? []).map((entry) => h("option", {
          key: entry.id,
          value: entry.id
        }, entry.name ?? entry.id)))), h("label", { className: "tc-field" }, h("span", {}, t("model")), h("select", {
          value: draft.model ?? "",
          disabled: member.retired === true || draft.provider == null || draft.provider === "",
          onChange: (event) => setDraft({
            model: event.target.value,
            effort: null
          })
        }, h("option", { value: "" }, "—"), models.map((entry) => h("option", {
          key: entry.model,
          value: entry.model
        }, entry.name && entry.name !== entry.model ? `${entry.model} · ${entry.name}` : entry.model)))), h("label", { className: "tc-field" }, h("span", {}, t("effort")), h("select", {
          value: draft.effort ?? "",
          disabled: member.retired === true || chosen === undefined || efforts.length === 0,
          onChange: (event) => setDraft({ effort: event.target.value || null })
        }, h("option", { value: "" }, t("defaultEffort")), efforts.map((entry) => h("option", {
          key: entry,
          value: entry
        }, entry)))), h("span", { className: "tc-spacer" }), dirty && !member.retired && draft.model !== null && draft.model !== "" ? h("button", {
          className: "tc-apply",
          type: "button",
          disabled: busy,
          onClick: async () => {
            const route = `${draft.provider ?? member.provider}/${draft.model}`;
            const payload = await run(`/crew set ${JSON.stringify(member.name)} ${JSON.stringify(route)}${draft.effort ? ` ${draft.effort}` : ""}`);
            if (payload === undefined) return;
            setMessage({ kind: "ok", text: payload.note ?? route });
            const fresh = await run("/crew list");
            if (fresh !== undefined) setView(fresh);
          }
        }, t("apply")) : null, member.retired === true ? h("button", {
          className: "tc-ghost",
          type: "button",
          disabled: busy,
          onClick: async () => {
            await run(`/crew restore ${JSON.stringify(member.name)}`);
            const fresh = await run("/crew list");
            if (fresh !== undefined) setView(fresh);
          }
        }, t("restore")) : h("button", {
          className: "tc-ghost",
          type: "button",
          disabled: busy,
          onClick: async () => {
            await run(`/crew retire ${JSON.stringify(member.name)} ${JSON.stringify(t("retireReason"))}`);
            const fresh = await run("/crew list");
            if (fresh !== undefined) setView(fresh);
          }
        }, t("retiring")), member.retired === true && member.retire_reason ? h("div", { className: "tc-msg" }, member.retire_reason) : null));
      }), h("div", { className: "tc-msg" }, t("help"))) : null);
    }
    return {
      inject: [
        "slots",
        "locale",
        "remote",
        "remote.commands",
        "sessions"
      ],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARY), "team-crew.locale");
        ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
          name: "conversation.session.header.actions",
          id: "team-crew",
          order: -19,
          locale: NS,
          inject: () => ({ ctx })
        }, CrewDesk));
      }
    };
  }
});
