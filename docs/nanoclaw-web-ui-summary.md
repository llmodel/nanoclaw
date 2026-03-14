# nanoclaw-web-ui: Developer Summary Report

> **Purpose**: Evaluate adoption/adaptation of `nanoclaw-web-ui` for LAN use with possible future Cloudflare tunnel exposure.
> **Background**: Full-stack dev familiar with FastAPI + Nuxt 4.

---

## Tech Stack

| Layer | Choice |
|-------|--------|
| Backend | Express.js + `ws` (WebSocket), TypeScript |
| Frontend | Vanilla JS + HTML + CSS — no framework, no build step |
| Testing | Vitest |
| Runtime | Node >= 20 |

The backend is a single class `WebUIServer` in `src/index.ts` (~441 lines). The frontend lives entirely in `/public/` and is served as static files — no bundler, no transpilation.

---

## Project Structure

```
nanoclaw-web-ui/
├── src/index.ts            # Express + WebSocket server (~441 lines)
├── public/
│   ├── index.html
│   ├── js/app.js           # ~2168 lines, vanilla JS monolith
│   ├── css/styles.css      # ~2500 lines, single stylesheet
│   └── i18n/
│       ├── en.json
│       └── zh-CN.json
└── examples/
```

---

## Integration with NanoClaw

Published as the npm package `nanoclaw-web-ui`. Integration pattern:

1. Import `WebUIServer` and instantiate it alongside existing channels.
2. Requires NanoClaw **v1.2.1+** (channel registry system).
3. Web sessions get a JID of the form `web:{sessionId}`, which slots into NanoClaw's router via the standard `onMessage` callback — no special-casing needed.

### REST API

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | Liveness check |
| `GET /api/session` | Session info |
| `POST /api/broadcast` | Send to all sessions |
| `POST /api/send` | Send to a specific session |

### WebSocket

`/ws` — real-time bidirectional messaging. Clients auto-reconnect with exponential backoff.

---

## Notable Features

- **Multi-session chat** with LocalStorage persistence (500 msg/session cap)
- **File uploads**: images, PDF, code files — 10 MB max
- **Message search** (Ctrl+K) and **Markdown export** of chat history
- **Dark/light theme** toggle
- **i18n**: English + zh-CN out of the box
- **Usage stats**: 7-day activity chart
- **Optional token auth**: disabled by default; defaults to `localhost` binding for safety

---

## Adopt vs. Adapt Assessment

### Pros
- Extremely lightweight — no frontend build pipeline to maintain
- Rich feature set for the size (search, export, file uploads, themes, i18n)
- Well-structured TypeScript backend; easy to read and extend
- Trivial to embed: one import, one constructor

### Cons
- `app.js` is a **2100+ line monolith** with no component model — unfamiliar territory compared to Nuxt's SFC approach
- `styles.css` is a similarly monolithic ~2500-line file
- No type safety on the frontend; debugging JS state is less ergonomic than Vue devtools
- No hot-reload in development for the frontend

### Verdict

**Adopt as-is for LAN use.** The complexity-to-feature ratio is excellent and there's nothing to build or compile. The vanilla JS roughness only matters if you need to extend the frontend significantly.

**If web exposure becomes real**, consider replacing `public/js/app.js` with a lightweight Nuxt 4 app that talks to the same Express + WebSocket backend. The backend API surface is clean and small enough that a frontend swap is straightforward — keep the server, replace the client.

---

## Cloudflare Tunnel Notes

Default config binds to `localhost` — this is intentional for safety. To expose via a CF tunnel:

1. **Change the bind address** to `0.0.0.0` (or the specific interface CF tunnel's `cloudflared` process reaches).
2. **Enable `wss://`**: CF tunnel terminates TLS, so the backend itself stays plain `ws://`, but ensure the frontend constructs the WebSocket URL dynamically based on `window.location.protocol` — verify `app.js` does this (look for `ws://` hardcodes).
3. **Enable token auth**: the optional token auth feature should be turned on when the interface is no longer LAN-only.
4. **CORS/headers**: CF tunnel passes standard headers; Express should be fine without changes unless you add extra origin checks.

The auto-reconnect with exponential backoff handles the occasional CF tunnel hiccup gracefully.
