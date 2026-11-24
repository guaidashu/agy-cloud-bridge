# Security Policy

## Security Architecture Overview

`agy-cloud-bridge` is designed with defense-in-depth for connecting cloud AI agents to a developer's local machine:

1. **Per-Project Scoped HMAC-SHA256 Authentication**
   - Every HTTP request is signed with `HMAC-SHA256` over method, path+query, timestamp, nonce, and SHA-256 of the request body.
   - A 5-minute replay window + in-memory nonce cache prevent replay attacks.
   - Each enrolled repository receives an isolated `proj_...` token scoped strictly to its own `projectId` (and optionally its declared multi-repo `group`).
2. **Private Repository Guard**
   - `enroll` writes the project-scoped token into `.agents/bridge.json` for zero-env-var cloud ergonomics.
   - **Never commit `.agents/bridge.json` to a public repository.** `enroll` automatically checks whether a GitHub repository is publicly reachable (`HTTP 200`) and refuses by default unless `--allow-public-repo` is explicitly passed.
   - If a project token is ever exposed, rotate it immediately:
     ```bash
     node src/cli.js project rotate-token <projectId>
     ```
3. **External Workspace `PreToolUse` Guardrail**
   - Local headless `agy` sessions run inside an isolated workspace under `~/.agy-bridge/workspaces/` with a `PreToolUse` hook (`bridge/agy-bridge-guard.mjs`) that blocks:
     - interactive/blocking tools (`ask_question`, `schedule`, etc.),
     - reads/writes outside allowed repo/scratch roots,
     - access to sensitive credential paths (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.agy-bridge`, `security.deniedReadRoots`),
     - environment dumping (`env`, `printenv`, `export -p`),
     - destructive system commands (`launchctl`, `osascript`, `rm -rf /`, `git push --force`), and
     - `git push` when `allowGitPush: false`.
4. **Pre-flight & Post-flight Git Hygiene**
   - **Pre-flight**: Default `dirtyPolicy: "safe-block"` refuses to pull or run if the user has uncommitted local work (`phase=dirty_tree`).
   - **Post-flight**: If a local `agy` run exits (success, failure, or timeout) leaving dirty files behind, the bridge automatically runs `git stash push -u -m "agy-bridge-leftover:<handoffId>"` so no files are lost and future rounds never deadlock, while preserving gitignored markers (`.agy-local`) and untouched pre-existing edits in unchanged peer repos.
5. **Automatic Redaction**
   - Responses, summaries, errors, and audit logs pass through `src/redact.js`, scrubbing private keys, `proj_...` tokens, bearer tokens, proxy credentials, and any custom `.env` files listed in `security.extraRedactEnvFiles`.
6. **Optional Fail-Closed Egress Proxy Isolation**
   - Setting `agy.requireProxy = true` with `agy.launcher` guarantees local `agy` runs exclusively through your egress proxy script and fails closed if the proxy check fails.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities. Instead:

- Use GitHub's **Private Vulnerability Reporting** ("Security" → "Report a vulnerability") on this repository, or contact the maintainer privately.
- Include reproduction steps, affected files/versions, and potential impact.
- We aim to acknowledge reports within 72 hours and ship a fix as quickly as possible.
