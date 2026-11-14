// Installed as <agent dir>/extensions/baton-bridge-status.js. No network: each pi process writes
// <status dir>/<sessionId>.<pid>.json; the fork guard stops a terminal branching a session Baton continued.
import * as fs from "node:fs";
import * as path from "node:path";

const DIR = __STATUS_DIR__;
let procStart = null;
try { const stat = fs.readFileSync("/proc/self/stat", "latin1"); procStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; } catch {}

function lastEntryId(file) {
	try {
		const size = fs.statSync(file).size;
		const buf = Buffer.alloc(Math.min(size, 1 << 20));
		const fd = fs.openSync(file, "r");
		try { fs.readSync(fd, buf, 0, buf.length, size - buf.length); } finally { fs.closeSync(fd); }
		// The last complete entry, parsed: custom entries put their id after other fields.
		const x = JSON.parse(buf.toString("utf8").trimEnd().split("\n").at(-1));
		return x.type === "session" ? null : x.id ?? null;
	} catch { return null; }
}

function busyElsewhere(id) {
	try {
		return fs.readdirSync(DIR).some((name) => {
			if (!name.startsWith(`${id}.`) || !name.endsWith(".json")) return false;
			const r = JSON.parse(fs.readFileSync(path.join(DIR, name), "utf8"));
			try { process.kill(r.pid, 0); } catch { return false; }
			return r.pid !== process.pid && (r.state === "running" || r.state === "waiting");
		});
	} catch { return false; }
}

export default function (pi) {
	let file = null;
	function write(ctx, state) {
		try {
			const id = ctx?.sessionManager?.getSessionId?.();
			if (!id || !ctx.sessionManager.getSessionFile?.()) return; // --no-session
			const target = path.join(DIR, `${id}.${process.pid}.json`);
			if (file && file !== target) fs.rmSync(file, { force: true });
			fs.mkdirSync(DIR, { recursive: true });
			fs.writeFileSync(`${target}.tmp`, JSON.stringify({ sessionId: id, cwd: ctx.cwd, pid: process.pid, procStart, mode: ctx.mode, state, updatedAt: Date.now() }));
			fs.renameSync(`${target}.tmp`, file = target);
		} catch {}
	}
	pi.on("session_start", (_e, ctx) => write(ctx, "idle"));
	pi.on("agent_start", (_e, ctx) => write(ctx, "running"));
	// agent_end may be followed by a retry, compaction or a queued message; agent_settled is final.
	pi.on("agent_settled", (_e, ctx) => write(ctx, "idle"));
	pi.on("ui_prompt_start", (_e, ctx) => write(ctx, "waiting"));
	pi.on("ui_prompt_end", (_e, ctx) => write(ctx, ctx.isIdle?.() ? "idle" : "running"));
	pi.on("session_shutdown", () => { if (file) fs.rmSync(file, { force: true }); file = null; });

	// Refused while another pi process (Baton) runs the session, or once it appended to it.
	pi.on("input", (event, ctx) => {
		const sm = ctx.sessionManager;
		const file = event.source === "interactive" && sm?.getSessionFile?.();
		if (!file || (!busyElsewhere(sm.getSessionId()) && [null, sm.getEntries().at(-1)?.id].includes(lastEntryId(file)))) return { action: "continue" };
		ctx.ui.notify("This session is running or was continued in Baton. When it is done, run /baton-reload, then send again.", "warning");
		return { action: "handled" };
	});
	pi.registerCommand("baton-reload", {
		description: "Reload this session after it was continued in Baton",
		handler: async (_args, ctx) => { await ctx.switchSession(ctx.sessionManager.getSessionFile()); },
	});
}
