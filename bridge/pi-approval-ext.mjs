// Passed with -e to the pi processes the Bridge starts (never installed): asks before tools run, adds
// ask_user, and stamps each prompt Baton sent with its turn id (stored as live:user:<turnId>).
import fs from "node:fs";

const UNGATED = new Set(["read", "grep", "find", "ls", "ask_user"]);
const TURN = /^<!--baton:([\w-]+)-->/;

// The session grant a call needs: bash = the program and a plain lowercase subcommand ("git status"),
// others = the tool. Any other bash command (shell syntax, a bare program, a flag, path or file second,
// a wrapper such as "sudo rm") gets none, so it is asked every time.
function grantOf(toolName, input) {
	if (toolName !== "bash") return toolName;
	const command = String(input?.command ?? "").trim();
	const [program, sub] = command.split(/\s+/);
	return /^[\w \t./:=@%+,-]+$/.test(command) && /^[a-z]+$/.test(sub ?? "")
		&& !/^(timeout|env|nice|nohup|sudo|doas|xargs|time|command|exec|eval|stdbuf|ionice|sh|bash|zsh)$/.test(program) ? `bash:${program} ${sub}` : null;
}

function granted(grant) {
	let grants = [];
	try { grants = JSON.parse(fs.readFileSync(process.env.BATON_PI_GRANTS, "utf8"))[process.env.BATON_PI_SESSION] || []; } catch {}
	return !!grant && grants.includes(grant);
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
		const grant = grantOf(event.toolName, event.input);
		if (UNGATED.has(event.toolName) || granted(grant)) return undefined;
		const body = JSON.stringify({ toolName: event.toolName, input: event.input, grant });
		if (await ctx.ui.confirm("baton:permission", body, { signal: ctx.signal })) return undefined;
		return { block: true, reason: `${event.toolName} was denied by the user` };
	});
	// Pi has no multi-select dialog: it rides on input(), answered with a JSON array.
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
