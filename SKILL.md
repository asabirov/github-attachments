---
name: github-attachments
description: "Attach an image or PDF to a GitHub issue, PR, or comment without committing it to the repository. Returns a GitHub attachment URL; images render inline and PDFs render as download links. Use when a screenshot, a diagram, a before-and-after or any picture belongs in something you are about to file or open. Trigger on: attach a PDF, upload homework files to an issue, attach a screenshot, put this image in the issue, add a picture to the PR, screenshot in the PR body, show the before and after, upload an image to GitHub, embed an image in a comment, the image does not render, my attachment 404s."
---

# github-attachments

One command. A path goes in, a URL comes out, and the image or PDF is accessible from any issue, pull
request or comment on the repository you named.

```bash
scripts/mint.sh shot.png --repo example-owner/example-repo
# https://github.com/user-attachments/assets/00000000-0000-4000-8000-000000000000

scripts/mint.sh shot.png --repo example-owner/example-repo --format markdown
gh pr edit 42 --repo example-owner/example-repo --body-file body.md
```

Repository names and attachment IDs in examples are synthetic placeholders, not live assets.

## Decision

**Drive a signed-in browser's own paste handler, and mint a URL that callers embed
themselves.** Two alternatives were tried and turned down on 2026-09-03.

*Commit the file into the repository* — write it to `.github/pr-screenshots/`, link the blob.
It works with the token every agent already holds and it runs on CI, which nothing here
does. It was turned down on two counts. An image enters git history forever to say something
that is true for one afternoon. A reader outside a private repo then sees nothing anyway.

*Call GitHub's upload endpoint directly* — reimplement the policy-then-S3-then-confirm dance
the web UI performs. Turned down because it cannot be authenticated: `POST
github.com/upload/policies/assets` with a personal access token and a real repository id
answered **422** with GitHub's generic error page rather than a policy. That endpoint wants
a session cookie and a CSRF token. There is no token path, so there is no CI path.

Decided by that 422. Once a browser session is the only key, the cheapest correct thing is
to let the editor GitHub already ships do the upload, and read the answer out of its
textarea.

## Three things that will mislead you

**The URL is a reference, not a file.** `github.com/user-attachments/assets/<uuid>` returns
**404** on a private repository's asset no matter who asks — signed in, repo owner, does not
matter. GitHub rewrites it at render time to a `private-user-images.githubusercontent.com`
URL carrying a JWT that expires in about five minutes. On a **public** repository the plain
URL does fetch: `200 image/png`, verified against `cli/cli`. So a direct `curl` proves
nothing on a private repo, and the honest check is to read the rendered body:

```bash
gh api repos/OWNER/REPO/pulls/N -H 'Accept: application/vnd.github.html+json' --jq .body_html
```

**The asset belongs to a repository, not to you.** The `repository_id` is captured at upload
time from the page the paste happened on. That is why `--repo` is required and not a guess:
mint against repo A, embed in repo B, and it renders for you and 404s for your reader.

**Never put the bytes through a conversation.** `mint.sh` takes a path and prints a URL, and
it must stay that way. A 416 KB screenshot is 554,756 characters of base64 — on the order of
150k tokens through an agent's context to accomplish what a path accomplishes for about 200.
For the same reason, do not `Read` an image in order to upload it. You do not need to see it.

## Drivers

`--driver auto` picks the first that works.

| Driver | When | Setup |
| --- | --- | --- |
| `orca` | `ORCA_WORKTREE_ID` is set and `orca` is on PATH | Node.js and `file` on PATH; uses the Orca browser session, exits 4 if signed out |
| `chrome` | everywhere else | `scripts/login.sh`, once |

The Chrome driver runs headless with no dependencies: Node has had a global `WebSocket`
since v21, so it speaks the DevTools Protocol with nothing installed. It deliberately does
not import puppeteer out of `browser-tools` — a skill reaching into another skill's
`node_modules` is the coupling this skill avoids — and it deliberately does not use
`~/.cache/browser-tools`, which every Claude session on this machine shares. A live GitHub
session parked there would let any session act as you. It lives in
`~/.claude/state/github-attachments/chrome-profile` instead.

It also picks port **9375**, not 9222, so it never fights the browser other sessions hold.

The Orca driver binds upload and cleanup to its created page ID, checks the target repository URL, and parses only structured result fields. Paste, polling and draft cleanup run in one browser evaluation because separate Orca evaluations may lose page state. Node.js builds the request without printing image bytes. Large transfers use bounded arguments; the Chrome driver has no CLI argument transfer.

### PDF documents

Use the same command with a `.pdf` path. PDF URLs use
`https://github.com/user-attachments/files/<id>/<filename>`; preserve the full URL.
`--format markdown` returns a normal link and `--format html` returns an anchor.
Images keep their existing inline rendering. The helper retains its conservative
10 MB file limit for both types.

The Orca driver stages large files in bounded calls within its own tab before
pasting. Staging uses a unique origin-storage key; SHA-256 is checked before paste. Cleanup is retried on exit, with a warning naming the key if it cannot be verified. Browser origin-storage quota
can limit large transfers; a staging failure returns no URL. The Chrome driver
does not use this staging path.

### The one manual step

GitHub's upload needs a session, and no script can create one — that is a password and a
second factor. `scripts/login.sh` opens a visible Chrome against this skill's own profile,
waits for the sign-in to land, and prints the login it saw. Every run after that is headless
and unattended until the session expires. Inside Orca you never need it.

## What it refuses, and why it refuses early

Everything below is decided before a browser starts. The failure that actually cost time was
an oversize image: it uploaded for a minute and then timed out. GitHub rejects on size
*after* the transfer, so the refusal has to happen here instead.

| Exit | Means |
| --- | --- |
| 2 | bad arguments, missing file, `--repo` not `owner/name`, or over GitHub's 10 MB limit |
| 3 | no browser could be opened |
| 4 | that browser is not signed in to GitHub |
| 5 | no comment editor on the page — repo missing, invisible, or issues disabled |
| 6 | the editor ignored the paste |
| 7 | the upload never returned a URL within `--timeout` |

Signed out gets its own exit code on purpose: it is the failure that otherwise looks
exactly like a broken upload, and it is the one with a one-command fix.

## How the upload actually happens

`lib/paste.js` builds a `File` in the page, puts it in a `DataTransfer`, and dispatches a
`paste` at the markdown editor. GitHub's own JavaScript does the upload it already knows how
to do and writes the finished reference into the textarea, which is then read back and
cleared so no draft is left behind.

Two editors exist and both take a paste: the classic issue and PR pages use textareas named
`new_comment_field` and `fc-<resource>-body`, and the newer `/issues/new` page is a React
editor with a generated id. `/issues/new` is what `mint.sh` targets, because it is the one
page that exists on every repository — no issue or PR has to be there first.

**`DOM.setFileInputFiles` does not work here**, which is what `orca upload` and most CDP
recipes use. GitHub keeps its file input out of the accessibility tree behind an "Attach
files" button, so the element ref never resolves, and on `/issues/new` there is no file
input at all. Exposing the input with CSS does not put it back in the tree either. The paste
was not the clever route; it was the only one.

## Tests

```bash
tests/mint-cli.test.sh                    # what it refuses, all before a browser starts
tests/polling-survives-uploading.test.sh  # actual driver: page isolation, pending upload, and refusals
node tests/test_paste_lib.mjs             # the paste library against a fake DOM
node --test tests/orca-driver.test.mjs   # PDF/image output, large transfers and cleanup
```

None of them touches the network. The polling shell entry point runs the Orca driver suite. The end-to-end path is exercised by
using it: mint an image, put it in a body, and read the rendered body back.
