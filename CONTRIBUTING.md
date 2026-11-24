# Contributing to agy-cloud-bridge

Thank you for your interest in improving `agy-cloud-bridge`!

## Design Principles

1. **Zero external runtime dependencies**: Keep the gateway pure Node.js (v18+ ESM standard library) and the cloud client (`scripts/handoff.sh`) zero-dependency dual-runtime (`python3` + `node`).
2. **Low local SSD wear**: Keep local disk I/O minimal, ephemeral artifacts isolated in `runsDir`/`worktreesDir` (optionally `/tmp` or RAM disk), and immediately purged on `--ack`.
3. **Fail-closed safety**: Never weaken authentication, path/branch allowlists, `PreToolUse` guardrails, or Pre-flight `dirty_tree` protection for user edits.
4. **No personal paths or credentials**: Never commit real domains, tokens, usernames, local paths (`/Users/...`), or private repo URLs.

## Local Development & Testing

```bash
# 1. Syntax checks across all JS/MJS and shell scripts
for f in src/*.js bridge/*.mjs test/*.test.js; do node --check "$f"; done
bash -n scripts/handoff.sh scripts/cloud-sync-gate.sh start.sh stop.sh deploy/proxy/agy-proxy-launcher.sh.example

# 2. Run the full unit + end-to-end test suite
npm test
```

## Pull Request Checklist

- [ ] Code stays zero-dependency and works on Node.js 18+ (macOS & Linux).
- [ ] All existing tests pass (`npm test`), and new features or bug fixes include targeted tests in `test/`.
- [ ] Bilingual documentation (`README.md` and `README.zh-CN.md`) is updated if user-facing CLI flags, config keys, or workflows changed.
- [ ] No hardcoded personal paths, domains, or credentials were introduced.
