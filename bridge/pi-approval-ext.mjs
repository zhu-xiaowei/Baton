// Pi extension the Bridge passes with -e to the pi processes it starts (never installed). It asks
// before tools run (unless granted for the session), adds an ask_user tool, and stamps each prompt
// Baton sent with its turn id so the stored message keeps it (live:user:<turnId>).
import fs from "node:fs";

const UNGATED = new Set(["read", "grep", "find", "ls", "ask_user"]);
const TURN = /^<!--baton:([\w-]+)-->/;

// bash: the program, plus a plain-word subcommand ("git status"); others: the tool.
function grantOf(toolName, input) {
	if (toolName !== "bash") return toolName;
	const t = String(input?.command ?? "").trim().split(/\s+/);
	return `bash:${t.length > 1 && /^[a-z][\w-]*$/i.test(t[1]) ? `${t[0]} ${t[1]}` : t[0]}`;
}

// A compound command is granted only when every part is.
function granted(toolName, input) {
	let grants = [];
	try { grants = JSON.parse(fs.readFileSync(process.env.BATON_PI_GRANTS, "utf8"))[process.env.BATON_PI_SESSION] || []; } catch {}
	if (toolName !== "bash") return grants.includes(toolName);
	const parts = String(input?.command ?? "").split(/&&|\|\||;|\||\n|`|\$\(/).map((s) => s.trim()).filter(Boolean);
	return parts.length > 0 && parts.every((part) => grants.some((g) => g.startsWith("bash:")
		&& (part === g.slice(5) || part.startsWith(`${g.slice(5)} `))));
}

export default function (pi) {
	const turns = [];
	pi.on("input", (event) => {
		const m = TURN.exec(event.text);
		if (!m) return { action: "continue" };
		turns.push(m[1]);
		return { action: "transform", text: event.text.slice(m[0].length), images: event.images };
	});
	pi.on("message_end", (event) => {
		if (event.message.role === "user" && turns.length) return { message: { ...event.message, batonTurnId: turns.shift() } };
	});
	pi.on("tool_call", async (event, ctx) => {
		if (UNGATED.has(event.toolName) || granted(event.toolName, event.input)) return undefined;
		const body = JSON.stringify({ toolName: event.toolName, input: event.input, grant: grantOf(event.toolName, event.input) });
		if (await ctx.ui.confirm("baton:permission", body, { signal: ctx.signal })) return undefined;
		return { block: true, reason: `${event.toolName} was denied by the user` };
	});
	// Pi has no multi-select dialog: a multiple-choice question rides on input() and the Bridge answers
	// with a JSON array of the chosen options.
	pi.registerTool({
		name: "ask_user",
		label: "Ask user",
		description: "Ask the user a multiple-choice question and wait for the answer. Set multiple to let them pick several options.",
		parameters: { type: "object", required: ["question", "options"], properties: {
			question: { type: "string" }, options: { type: "array", items: { type: "string" } }, multiple: { type: "boolean" } } },
		async execute(_id, params, signal, _onUpdate, ctx) {
			let answer = params.multiple
				? await ctx.ui.input("baton:multiselect", JSON.stringify(params), { signal })
				: await ctx.ui.select(params.question, params.options, { signal });
			if (params.multiple && answer != null) try { answer = JSON.parse(answer).join(", "); } catch {}
			return { content: [{ type: "text", text: answer ?? "(cancelled)" }], details: {} };
		},
	});
}
