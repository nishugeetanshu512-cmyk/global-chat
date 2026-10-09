# Ridge – Real-Time Chat (First Commit Hackathon)

A web chat app with accounts, 1:1 and group chat, live delivery over WebSockets, persistent history, file and voice sharing, and an AI participant.

## Features
**Core:** register / sign in / sign out with persistent server-side sessions; private one-to-one chat; real-time delivery; messages stored per user and conversation.

**Extras:** group chats · SQLite persistence (users, sessions, conversations, memberships, messages, timestamps) · typing indicators · online/offline presence · read receipts and unread badges · message edit and delete · message search · image / PDF / text / audio / video sharing · in-browser voice notes · file safety checks · AI assistant (`@ai` in any chat, or DM "Assistant") that uses recent chat history as context · desktop notifications · mobile-friendly layout, auto-reconnect.

## Architecture
```
Browser (vanilla JS)  ──HTTP──>  Express: auth, uploads, history, search
        │                              │
        └────── WebSocket (/ws) ───────┤  ws: send, typing, read, edit, delete, presence
                                       ├─ SQLite (better-sqlite3), data/chat.db
                                       ├─ data/uploads (private, membership-checked)
                                       └─ Anthropic API (server-side only)
```
- **Auth:** bcrypt-hashed passwords, random 256-bit session token in an HttpOnly, SameSite=Lax cookie, stored in the DB (7-day expiry). The WebSocket upgrade is authenticated with the same cookie and rejects cross-origin requests. Auth endpoints are rate-limited.
- **Real time:** server fans each event out to every connected socket of every member of that conversation. Clients reconnect automatically and re-sync history.
- **File safety:** extension allowlist, magic-byte verification, executable-signature rejection, PDF active-content (`/JavaScript`, `/Launch`) blocking, 10 MB limit, random stored names, files only served to conversation members with `nosniff`, a restrictive CSP and `attachment` disposition for non-media.
- **Secrets:** the API key lives only in server environment variables; `.env` is git-ignored.

## Run locally
Requires Node.js 18+.
```bash
npm install
cp .env.example .env      # optional: add ANTHROPIC_API_KEY to enable the AI assistant
npm start                 # http://localhost:3000
```

### Environment variables
| Name | Purpose |
|---|---|
| `PORT` | Port (default 3000) |
| `ANTHROPIC_API_KEY` | Optional. Enables the AI assistant |
| `ANTHROPIC_MODEL` | Optional. Default `claude-sonnet-5-5` |
| `DATA_DIR` | Optional. Where the DB and uploads live (default `./data`) |
| `NODE_ENV=production` | Adds the `Secure` flag to the session cookie (use behind HTTPS) |

## Test it in a clean environment
1. `npm install && npm start`
2. Open `http://localhost:3000` in a normal window and an incognito window.
3. Register `alice` in one and `bob` in the other.
4. Search "bob" as alice, open the chat, and send a message. It appears instantly for bob, with a typing indicator and "Seen".
5. Try New group, attach an image, record a voice note, and message `Assistant` (needs an API key).
6. Restart the server and sign in again. History and the session persist.

## Deploy
Any Node host with a persistent disk (Render, Railway, Fly.io). Set `NODE_ENV=production`, mount a volume and point `DATA_DIR` to it. Serverless platforms such as Vercel and Netlify do not support long-lived WebSockets.

## Possible next steps
End-to-end encryption (Web Crypto key exchange), reactions, Redis pub/sub for multi-instance scaling, object storage for uploads.
