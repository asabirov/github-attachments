// The whole upload, as one expression a browser can evaluate.
//
// GitHub has no API for this. The web UI POSTs to github.com/upload/policies/assets
// with a session cookie and a CSRF token, gets back a signed S3 policy, uploads there,
// and is handed back a github.com/user-attachments/assets/<uuid> reference. A personal
// access token cannot reach that endpoint: tried 2026-09-03 against a real repository id
// and it answered 422 with GitHub's generic error page, not a policy. So the only way in
// is a page that is already signed in.
//
// Rather than reimplement that three-step dance and re-break it every time GitHub moves
// the endpoint, this hands a File to the editor's own paste handler and lets GitHub's
// JavaScript do the upload it already knows how to do. The editor writes the finished
// reference into its textarea, and we read it back out.
//
// Two editors exist and both take a paste. The classic issue and PR pages use textareas
// named new_comment_field and fc-<resource>-body; the newer /issues/new page is a React
// editor whose textarea has a generated id and no file input at all. Matching on the
// placeholder and the id together covers both without knowing which one loaded.
//
// Deliberately not used: orca upload / CDP DOM.setFileInputFiles. It needs the real
// input element, and GitHub keeps that input out of the accessibility tree behind an
// "Attach files" button, so the ref never resolves. On /issues/new there is no file
// input to find at all.

globalThis.__ghAttach = {
	// Every textarea GitHub might have put a markdown editor behind, best candidate first.
	editors() {
		const all = [...document.querySelectorAll("textarea")];
		const named = (t) =>
			t.id === "new_comment_field" ||
			/^fc-.*-body$/.test(t.id) ||
			/description|comment/i.test(t.placeholder || "");
		return [...all.filter(named), ...all.filter((t) => !named(t))];
	},

	// Hand the file to the editor exactly as a paste would.
	//
	// The editor cancels the event when it takes the file, so defaultPrevented is the
	// only synchronous signal that anything is listening. A false here means the paste
	// went nowhere and no amount of waiting will produce a URL.
	paste(base64, filename, mime) {
		const editor = this.editors()[0];
		if (!editor) return { ok: false, reason: "no-editor" };

		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

		const transfer = new DataTransfer();
		transfer.items.add(new File([bytes], filename, { type: mime }));

		editor.focus();
		const taken = !editor.dispatchEvent(
			new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }),
		);
		return { ok: taken, reason: taken ? null : "editor-ignored-paste", id: editor.id, bytes: bytes.length };
	},

	// The upload is asynchronous, so the reference appears in the textarea some time after
	// the paste. Returning "pending" rather than an error lets the caller keep waiting.
	harvest() {
		const editor = this.editors()[0];
		if (!editor) return { state: "no-editor" };
		const found = /user-attachments\/assets\/([0-9a-f-]{36})/.exec(editor.value);
		if (found) return { state: "done", uuid: found[1], url: `https://github.com/user-attachments/assets/${found[1]}` };
        const file = /https:\/\/github\.com\/user-attachments\/files\/\d+\/[^\s)"<>]+/.exec(editor.value);
        if (file) return { state: "done", url: file[0] };
		// GitHub writes a "Uploading file..." placeholder while it works.
		if (/uploading/i.test(editor.value)) return { state: "uploading" };
		return { state: "pending" };
	},

	// Leave no draft behind. GitHub persists comment and new-issue drafts, so skipping
	// this leaves half an image in a box the human opens later. Assigning through the
	// prototype setter is what makes React notice the change; editor.value = "" alone
	// updates the DOM and leaves React's own state holding the old text.
	clear() {
		const editor = this.editors()[0];
		if (!editor) return { cleared: false };
		const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
		set.call(editor, "");
		editor.dispatchEvent(new Event("input", { bubbles: true }));
		return { cleared: editor.value.length === 0 };
	},

	// Signed out is the failure that looks like every other failure, so it gets its own
	// question. GitHub puts the viewer's login in a meta tag on every page it serves.
	whoami() {
		return document.querySelector("meta[name=user-login]")?.content || null;
	},
};
