#!/usr/bin/env node
// Mint through a headless Chrome this skill owns, for every session Orca is not running.
//
// Zero dependencies on purpose. Node has had a global WebSocket since 21, so the DevTools
// Protocol is reachable with nothing installed — which matters because the alternative was
// importing puppeteer out of the browser-tools skill, and a skill reaching into another
// skill's node_modules is the coupling this skill avoids.
//
// The profile lives in ~/.claude/state/github-attachments/, never in the checkout. It holds
// a live GitHub session, so it deliberately does not go in ~/.cache/browser-tools: that
// directory is shared by every Claude session on this machine, and a session cookie parked
// there would let any of them act as the human on GitHub.
//
// Usage: chrome.mjs <image> <owner/repo> <timeout-seconds> [--login]
// Prints: the asset uuid on stdout. Everything else goes to stderr.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "..", "lib", "paste.js");
const PROFILE = join(homedir(), ".claude", "state", "github-attachments", "chrome-profile");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9375; // Not 9222: that port is browser-tools', shared by every session here.

const [image, repo, timeoutArg, ...rest] = process.argv.slice(2);
const login = rest.includes("--login");
const timeoutMs = Number(timeoutArg || 60) * 1000;

const die = (code, ...lines) => {
	for (const l of lines) console.error(`chrome: ${l}`);
	process.exit(code);
};

// --- Chrome -----------------------------------------------------------------

async function startChrome() {
	await mkdir(PROFILE, { recursive: true });
	const args = [
		`--remote-debugging-port=${PORT}`,
		`--user-data-dir=${PROFILE}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
	];
	// The login run wants a window; every other run must never steal focus.
	if (!login) args.push("--headless=new", "--disable-gpu");
	const child = spawn(CHROME, args, { stdio: "ignore", detached: true });
	child.unref();
	for (let i = 0; i < 100; i++) {
		try {
			const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
			if (r.ok) return child;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	die(3, "Chrome did not answer on the debugging port within 10s.");
}

async function connect(url) {
	const page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((res, rej) => {
		ws.onopen = res;
		ws.onerror = () => rej(new Error("could not attach to the page"));
	});

	let next = 1;
	const waiting = new Map();
	ws.onmessage = (e) => {
		const msg = JSON.parse(e.data);
		const pending = waiting.get(msg.id);
		if (!pending) return;
		waiting.delete(msg.id);
		msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result);
	};

	const send = (method, params) =>
		new Promise((resolve, reject) => {
			const id = next++;
			waiting.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params }));
		});

	// Returns the expression's value, already JSON-parsed where the caller asked for JSON.
	const evaluate = async (expression) => {
		const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "evaluate threw");
		return r.result.value;
	};

	return { page, evaluate, close: () => ws.close() };
}

async function settled(evaluate) {
	for (let i = 0; i < 100; i++) {
		if ((await evaluate("document.readyState")) === "complete") return;
		await new Promise((r) => setTimeout(r, 100));
	}
}

// --- the one-time login -----------------------------------------------------

if (login) {
	await startChrome();
	const tab = await connect("https://github.com/login");
	console.error("A Chrome window is open on github.com/login.");
	console.error("Sign in there, then close the window. The session stays in:");
	console.error(`  ${PROFILE}`);
	console.error("Waiting for the sign-in to land (Ctrl-C to give up)...");
	for (;;) {
		await new Promise((r) => setTimeout(r, 2000));
		let who = null;
		try {
			who = await tab.evaluate('document.querySelector("meta[name=user-login]")?.content || null');
		} catch {
			continue; // navigation tears the page down mid-question; that is normal here.
		}
		if (who) {
			console.error(`Signed in as ${who}. You can close the window.`);
			process.exit(0);
		}
	}
}

// --- the mint ---------------------------------------------------------------

if (!image || !repo) die(2, "usage: chrome.mjs <image> <owner/repo> <timeout-seconds>");

await startChrome();
const tab = await connect(`https://github.com/${repo}/issues/new`);
await settled(tab.evaluate);
await tab.evaluate(readFileSync(LIB, "utf8"));

const who = await tab.evaluate("globalThis.__ghAttach.whoami()");
if (!who) {
	die(
		4,
		"this browser is not signed in to GitHub.",
		"Run `scripts/login.sh` once; the session then persists for every later run.",
	);
}

if ((await tab.evaluate("globalThis.__ghAttach.editors().length")) === 0) {
	die(
		5,
		`no comment editor on https://github.com/${repo}/issues/new`,
		"Check the repository exists, that this account can see it, and that issues are enabled.",
	);
}

// Read straight to base64 so the bytes never become a string anyone has to look at.
const b64 = readFileSync(image).toString("base64");
const name = image.split("/").pop();
const mime = name.toLowerCase().endsWith(".png")
	? "image/png"
	: /\.jpe?g$/i.test(name)
		? "image/jpeg"
		: /\.gif$/i.test(name)
			? "image/gif"
			: /\.webp$/i.test(name)
				? "image/webp"
				: /\.pdf$/i.test(name) ? "application/pdf" : "application/octet-stream";

const pasted = await tab.evaluate(
	`globalThis.__ghAttach.paste(${JSON.stringify(b64)},${JSON.stringify(name)},${JSON.stringify(mime)})`,
);
if (!pasted?.ok) die(6, `the editor did not accept the paste (${pasted?.reason || "unknown"})`);

const deadline = Date.now() + timeoutMs;
for (;;) {
	const got = await tab.evaluate("globalThis.__ghAttach.harvest()");
	if (got?.state === "done") {
		await tab.evaluate("globalThis.__ghAttach.clear()");
		console.log(got.url);
		process.exit(0);
	}
	if (Date.now() > deadline) break;
	await new Promise((r) => setTimeout(r, 500));
}

await tab.evaluate("globalThis.__ghAttach.clear()");
die(7, `gave up after ${timeoutMs / 1000}s waiting for GitHub to return an asset URL`);
