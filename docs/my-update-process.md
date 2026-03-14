# Upstream Update Process

## When to Update

- **Monthly**: Run `git fetch upstream && git log HEAD..upstream/main --oneline` to see what's landed.
- **Immediately**: When upstream fixes a known bug affecting this install.

## How to Update

Run `/update-nanoclaw` and choose the **merge** strategy.

## Why Merge, Not Rebase

This fork is 28+ commits ahead of upstream with local customizations (web UI channel, OAuth auto-refresh, Telegram merge). Rebasing would rewrite all local commits. Merge preserves them as-is.

## Why Not Cherry-Pick by Default

Upstream doesn't use release tags — commits land directly on `main`. Pulling everything via merge is usually the right call. Cherry-pick only when you want 1–2 specific upstream fixes and want to skip the rest (e.g., an upstream change that conflicts with a local feature you want to keep).

## Conflict-Prone Files

These files are likely to conflict. Handle each as follows:

| File | How to resolve |
|------|---------------|
| `src/credential-proxy.ts` | Keep local OAuth auto-refresh logic; integrate upstream changes around it |
| `src/channels/index.ts` | Keep `import './web-ui.js'` |
| `package.json` / `package-lock.json` | Keep `nanoclaw-web-ui` dependency; accept upstream dep changes |
| `.env.example` | Keep `WEB_UI_*` vars; accept upstream additions |

## Post-Merge Checklist

1. `npm run build` — confirm no compile errors
2. `systemctl --user restart nanoclaw` — restart the service
3. Send a test message via Telegram — confirm routing works
4. Open the web UI — confirm it loads and responds
