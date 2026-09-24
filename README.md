# github-attachments

Upload images and PDFs to GitHub issues, pull requests, and comments from an AI coding agent or the terminal—without committing the files to the repository.

```text
Workflow diagram
Local file → signed-in browser → GitHub attachment URL → issue, PR, or comment
```

## Quick start

You need Bash, Node.js 21 or later, and one of these browser options:

- Orca with a signed-in GitHub browser session
- Google Chrome on macOS

The Orca driver also requires the `file` utility on PATH for MIME detection.
The tool has no npm dependencies. Its Chrome driver currently expects Chrome at the standard macOS application path.

Clone `asabirov/github-attachments-skill` and run the commands from the repository root. To use it from an agent, expose the checkout as the `github-attachments` skill. The agent instructions are in [SKILL.md](SKILL.md).

```bash
# Outside Orca: opens Chrome for a one-time GitHub sign-in.
scripts/login.sh

# Uploads a local file to GitHub. Replace the path and repository first.
scripts/mint.sh screenshot.png --repo example-owner/example-repo --format markdown
```

When running inside Orca, skip `login.sh`. The helper uses Orca's existing browser session instead.

The command uploads the file and prints Markdown that you can paste into an issue, pull request, or comment in the same repository. It does not submit the issue or comment.

Example output (synthetic ID, not a live attachment):

```markdown
![screenshot](https://github.com/user-attachments/assets/00000000-0000-4000-8000-000000000000)
```

PDFs use the same command and produce a download link:

```bash
scripts/mint.sh document.pdf --repo example-owner/example-repo --format markdown
```

By default, the command prints a URL. Use the following options when you need a different format or upload behavior:

- `--format markdown` or `--format html` returns an embeddable link.
- `--alt` sets the alternative text for the link.
- `--driver orca|chrome` selects the browser driver.
- `--timeout` sets the upload wait time in seconds. The default is `60`.

## Why it exists

Screenshots and documents are often useful in a review discussion but do not belong in the repository's Git history. This helper accepts a local file and returns a GitHub attachment URL, allowing an agent or developer to add visual evidence without sending the file bytes through the conversation.

The helper uses GitHub's own paste handler in a signed-in browser. The resulting link can be used in an issue, pull request, or comment; the caller decides where to place it.

## Limits and authentication

- You need a signed-in browser with access to the target repository. This is not a token-only CI uploader, and the repository must have its issue editor enabled.
- Upload the file to the repository where you will use the link. Private image references may require GitHub's rendered page to display correctly, so a direct fetch is not a reliable verification method.
- Files are limited to 10 MB. Orca stages large files in browser origin storage, so browser quota can limit uploads. Chrome transfers files through the DevTools Protocol.
- Chrome stores its signed-in profile outside the checkout at `~/.claude/state/github-attachments/chrome-profile`. Keep this profile private.

For driver behavior, cleanup, and exit codes, see [SKILL.md](SKILL.md).

## Tests and contributions

Run the offline test suites from the repository root:

```bash
tests/mint-cli.test.sh
tests/polling-survives-uploading.test.sh
node tests/test_paste_lib.mjs
node --test tests/orca-driver.test.mjs
```

The polling shell entry point also runs the Orca driver suite. These tests use synthetic fixtures: they do not upload files or contact GitHub. Browser compatibility with the live GitHub editor requires a separate check against GitHub's current behavior.

For changes, open an issue, work on a branch, run the tests, and submit a pull request. Keep credentials, browser profiles, and private attachments out of the repository.

## Install and roll back

Use a checkout or submodule pinned to a reviewed commit. Before updating, record the current revision so you can restore it if necessary.

To uninstall the skill, remove the skill link or submodule. Make source changes in a branch rather than editing an installed skill copy.

## License

[MIT](LICENSE), copyright 2026 Artur Sabirov.
