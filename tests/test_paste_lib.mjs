#!/usr/bin/env node
// Repository names, attachment IDs and document names are synthetic offline fixtures.
// The paste library, exercised against a fake DOM rather than a real GitHub.
//
// These are the branches that decide whether a failure is legible. Every one of them was
// a real wrong turn on 2026-09-03: the editor that never took the paste, the React box
// whose value survived being cleared, and the signed-out browser that looked exactly like
// a broken upload.

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "paste.js");

// --- the smallest DOM the library will accept -------------------------------

function makeDom({ textareas = [], login = null, takesPaste = true } = {}) {
	const setter = { calls: 0 };
	class FakeTextArea {
		constructor(spec) {
			Object.assign(this, { id: "", placeholder: "", value: "", ...spec });
			this.focused = false;
			this.events = [];
		}
		focus() {
			this.focused = true;
		}
		dispatchEvent(e) {
			this.events.push(e);
			if (e.type === "paste") {
				if (!takesPaste) return true; // nothing listening: event not cancelled
				this.value = spec_uploading;
				return false; // cancelled, i.e. the editor took the file
			}
			return true;
		}
	}
	let spec_uploading = "Uploading file...";
	const nodes = textareas.map((t) => new FakeTextArea(t));

	const win = {
		HTMLTextAreaElement: {
			prototype: {},
		},
	};
	Object.defineProperty(win.HTMLTextAreaElement.prototype, "value", {
		set(v) {
			setter.calls++;
			this.value = v;
		},
		configurable: true,
	});
	// The library reaches for the prototype setter, which on a real page is the only way
	// to make React notice. Emulate that by writing through to the node.
	Object.defineProperty(win.HTMLTextAreaElement.prototype, "value", {
		set(v) {
			setter.calls++;
			Object.getPrototypeOf(this) === FakeTextArea.prototype ? (this._v = v) : null;
			this.value = v;
		},
		configurable: true,
	});

	const document = {
		querySelectorAll: (sel) => (sel === "textarea" ? nodes : []),
		querySelector: (sel) =>
			sel === "meta[name=user-login]" ? (login ? { content: login } : null) : null,
	};

	const sandbox = {
		document,
		window: win,
		DataTransfer: class {
			constructor() {
				this.items = { added: [], add(f) { this.added.push(f); } };
			}
		},
		File: class {
			constructor(parts, name, opts) {
				Object.assign(this, { parts, name, type: opts?.type });
			}
		},
		ClipboardEvent: class {
			constructor(type, init) {
				Object.assign(this, { type, ...init });
			}
		},
		Event: class {
			constructor(type, init) {
				Object.assign(this, { type, ...init });
			}
		},
		atob: (b64) => Buffer.from(b64, "base64").toString("binary"),
		Uint8Array,
		setUploaded: (v) => nodes.forEach((n) => (n.value = v)),
		nodes,
		setter,
	};
	sandbox.globalThis = sandbox;
	return sandbox;
}

function load(sandbox) {
	const src = readFileSync(LIB, "utf8");
	const keys = Object.keys(sandbox);
	new Function(...keys, src)(...keys.map((k) => sandbox[k]));
	return sandbox.__ghAttach;
}

// --- the cases --------------------------------------------------------------

let pass = 0;
const it = (name, fn) => {
	try {
		fn();
		pass++;
		console.log(`ok   ${name}`);
	} catch (e) {
		console.log(`FAIL ${name}\n     ${e.message}`);
		process.exitCode = 1;
	}
};

it("prefers the classic comment box over any other textarea", () => {
	const s = makeDom({ textareas: [{ id: "random" }, { id: "new_comment_field" }] });
	assert.equal(load(s).editors()[0].id, "new_comment_field");
});

it("finds the React new-issue box by its placeholder", () => {
	const s = makeDom({ textareas: [{ id: "_r_c_", placeholder: "Type your description here…" }] });
	assert.equal(load(s).editors()[0].id, "_r_c_");
});

it("matches an edit-body box by its fc-<resource>-body id", () => {
	const s = makeDom({ textareas: [{ id: "x" }, { id: "fc-issue-123-body" }] });
	assert.equal(load(s).editors()[0].id, "fc-issue-123-body");
});

it("reports no-editor rather than throwing on a page with none", () => {
	const s = makeDom({ textareas: [] });
	assert.equal(load(s).paste("AA==", "a.png", "image/png").reason, "no-editor");
});

it("an editor that ignores the paste is reported, not waited on", () => {
	const s = makeDom({ textareas: [{ id: "new_comment_field" }], takesPaste: false });
	const r = load(s).paste("AA==", "a.png", "image/png");
	assert.equal(r.ok, false);
	assert.equal(r.reason, "editor-ignored-paste");
});

it("a cancelled paste counts as taken, and carries the byte count", () => {
	const s = makeDom({ textareas: [{ id: "new_comment_field" }] });
	const r = load(s).paste(Buffer.from("hello").toString("base64"), "a.png", "image/png");
	assert.equal(r.ok, true);
	assert.equal(r.bytes, 5);
});

it("harvest distinguishes uploading from pending from done", () => {
	const s = makeDom({ textareas: [{ id: "new_comment_field" }] });
	const lib = load(s);
	assert.equal(lib.harvest().state, "pending");
	s.setUploaded("Uploading file...");
	assert.equal(lib.harvest().state, "uploading");
	s.setUploaded('<img src="https://github.com/user-attachments/assets/00000000-0000-4000-8000-000000000000" />');
	const done = lib.harvest();
	assert.equal(done.state, "done");
	assert.equal(done.uuid, "00000000-0000-4000-8000-000000000000");
});

it("harvest returns a complete PDF URL including an encoded filename", () => {
 const s = makeDom({ textareas: [{ id: "new_comment_field" }] });
 const lib = load(s);
 const url = "https://github.com/user-attachments/files/0000000000/synthetic%20document.pdf";
 s.setUploaded(`[grammar.pdf](${url})`);
 assert.deepEqual(lib.harvest(), { state: "done", url });
});

it("clear goes through the prototype setter, which is what React watches", () => {
	const s = makeDom({ textareas: [{ id: "new_comment_field", value: "leftover" }] });
	load(s).clear();
	assert.ok(s.setter.calls > 0, "the prototype setter was never called");
	assert.equal(s.nodes[0].value, "");
});

it("whoami returns null when signed out and the login when signed in", () => {
	assert.equal(load(makeDom({ textareas: [] })).whoami(), null);
	assert.equal(load(makeDom({ textareas: [], login: "example-user" })).whoami(), "example-user");
});

console.log(`\n${pass} passed`);
