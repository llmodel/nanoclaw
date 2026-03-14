# Issues Encountered

## Web UI Integration (nanoclaw-web-ui)

### 1. `localhost` binding blocks LAN access

**Symptom:** `curl http://<vm-ip>:3000` fails; `ss -tlnp` shows `127.0.0.1:3000`.

**Cause:** `WebUIServer` defaults `HOST` to `localhost`. Even though `.env` had `WEB_UI_HOST=0.0.0.0`, the value wasn't reaching the server (see issue #2 below).

**Fix:** Set `WEB_UI_HOST=0.0.0.0` in `.env` and read it via `readEnvFile()` in the channel adapter (not `process.env`).

---

### 2. `.env` values are not in `process.env`

**Symptom:** Channel reads `process.env.WEB_UI_HOST` but gets `undefined`; server falls back to `localhost`.

**Cause:** NanoClaw intentionally does **not** load `.env` into `process.env` — this prevents secrets leaking into child containers. Values must be read with `readEnvFile(['KEY'])` from `src/env.ts`.

**Fix:** Replace `process.env.WEB_UI_*` reads with `readEnvFile(['WEB_UI_PORT', 'WEB_UI_HOST', 'WEB_UI_AUTH_TOKEN'])` in the channel adapter. Keep `process.env` as a fallback for values set outside `.env` (e.g. systemd `Environment=`).

---

### 3. Dynamic session JIDs are never registered — messages silently dropped

**Symptom:** Web UI shows typing indicator but no response. Logs show `New messages count: 1` but no `Processing messages` entry.

**Cause:** `WebUIServer` generates a unique session ID per connection (e.g. `web_1773461469543_sal21ey1t`). The channel was forwarding messages with `chatJid = web:<sessionId>`, but the message loop only processes messages whose JID is in `registeredGroups`. Transient session JIDs are never registered, so all messages were silently skipped.

**Fix:** Use a single stable JID `web:default` for all web sessions. All inbound messages are stored under this JID; `sendMessage` broadcasts to all active sessions. The user registers `web:default` once via the admin channel.

---

### 4. Non-main groups require a trigger word — messages silently ignored

**Symptom:** Web UI shows typing spinner (container cold-start) but agent never responds. `New messages count: 1` appears in logs with no follow-up processing.

**Cause:** Groups registered without `isMain: true` require the `TRIGGER_PATTERN` (e.g. `@Andy`) to be present in a message before the agent is invoked. Plain "Hello" has no trigger, so the message loop skips the group.

**Fix:** Prepend `@${ASSISTANT_NAME}` to every inbound web message inside the channel adapter. The browser UI is a personal assistant interface — every message should trigger the agent, so the trigger is added transparently rather than requiring users to type it.
