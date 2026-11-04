# Stewie

A WhatsApp bot for your own groups and chats, backed by the [Evolution API](https://docs.evolutionfoundation.com.br) (Baileys / WhatsApp Web transport) and an OpenAI-compatible model.

Stewie is a **personal tool**, not a product. It chats as your WhatsApp number, in the groups you choose, at your direction.

## How it fits together

```
WhatsApp ──► Evolution API (Baileys, holds the session) ──► webhook ──► Stewie
                                                                      │
                                                        Luna / MiniMax ─┘
                                                                      │
                                     Evolution API ──► WhatsApp ◄──────┘
```

- **Evolution API** owns the WhatsApp connection for `+27747778886`. It is installed at `/home/davai/evolution-api` and runs as the `evolution-api` systemd service on port `8080`.
- **Stewie** (this repo) owns the behaviour: it receives inbound messages, decides whether to answer, calls the model, and sends the reply. It runs as the `stewie` systemd service on port `8099`.

Because the paired number is your own, Stewie can already see every group you are in — there is no invite-link step, and no group needs to be recreated.

## Behaviour

Stewie replies in a chat when the policy allows it:

| Mode | Replies when |
| --- | --- |
| `never` | never |
| `mention` | the bot name (or an alias) appears in the message |
| `question` | the message looks like a question, or the bot is named |
| `always` | every message |

Defaults: groups use `mention`, direct chats use `always`. Every chat can be switched off individually.

Guards: per-chat cooldown, per-chat and global hourly reply caps, response probability, message de-duplication, rolling history with retention, and `STOP`/`UNSUBSCRIBE` opt-out.

## Setup

```sh
cd /home/davai/projects/stewie
cp .env.example .env    # then fill in the values
npm test
npm start
```

### Required configuration

| Variable | Purpose |
| --- | --- |
| `EVOLUTION_API_KEY` | Evolution REST API key (`apikey` header) |
| `EVOLUTION_INSTANCE` | Evolution instance name (`stewie`) |
| `STEWIE_HOST` | Bind address; default `127.0.0.1` (only Evolution needs to reach it) |
| `STEWIE_WEBHOOK_TOKEN` | Shared path token on the webhook URL |
| `STEWIE_ADMIN_TOKEN` | Bearer token for the admin API and QR endpoint |
| `STEWIE_MODEL_API_KEY` | Model API key |
| `STEWIE_MODEL_BASE_URL` | Model base URL, including the version path |
| `STEWIE_MODEL` | Model id |

`STEWIE_WEBHOOK_TOKEN` and `STEWIE_ADMIN_TOKEN` are compared in constant time. The webhook is the only inbound entry point and it is secret-path protected, because Evolution does not sign webhook payloads.

### Model providers

Any OpenAI-compatible `/chat/completions` endpoint works.

| Model | Base URL | Notes |
| --- | --- | --- |
| `gpt-5.6-luna` | `https://api.openai.com/v1` | Reasoning family: `temperature` is omitted and `max_completion_tokens` is used automatically |
| `MiniMax-M3` | `https://api.minimax.io/v1` | Sends `temperature`; `<think>` reasoning blocks are stripped from replies |

The model variables are deliberately prefixed `STEWIE_MODEL_*` so that a global
`OPENAI_API_KEY` in the login shell cannot silently point the bot at a different
provider. `OPENAI_*` is still honoured as a fallback.

**Current state on this box:** the OpenAI key has no credits
(`credit_balance_exhausted`), so the service runs on `MiniMax-M3`. Restoring
Luna is a three-line change in `.env` plus a restart.

## Pairing the number

1. Make sure the Evolution instance exists (`stewie`) and the service is running.
2. Read the pairing QR:

   ```sh
   curl -s -H "Authorization: Bearer $STEWIE_ADMIN_TOKEN" \
     http://127.0.0.1:8099/qr.png/$STEWIE_ADMIN_TOKEN -o /tmp/qr.png
   ```

3. On the phone: WhatsApp → **Settings → Linked devices → Link a device** → scan.
4. Confirm the state flips to `open`:

   ```sh
   curl -s -H "apikey: $EVOLUTION_API_KEY" http://127.0.0.1:8080/instance/connectionState/stewie
   ```

The pairing is stored by Evolution in Postgres, so it survives restarts.

## Admin API

All admin routes require `Authorization: Bearer $STEWIE_ADMIN_TOKEN`.

```sh
# list groups (including groups you have not posted in yet)
curl -s -H "Authorization: Bearer $STEWIE_ADMIN_TOKEN" http://127.0.0.1:8099/admin/groups

# switch a group on/off, or change its mode and persona
curl -s -X POST -H "Authorization: Bearer $STEWIE_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"enabled":true,"mode":"mention","persona":"dry, witty, short replies"}' \
  http://127.0.0.1:8099/admin/groups/<group-id>

# list direct chats
curl -s -H "Authorization: Bearer $STEWIE_ADMIN_TOKEN" http://127.0.0.1:8099/admin/chats

# pairing QR (PNG)
curl -s -o /tmp/qr.png -H "Authorization: Bearer $STEWIE_ADMIN_TOKEN" http://127.0.0.1:8099/qr.png/<token>
```

Group ids look like `120363012345678901@g.us`. The same id is used by `GET /group/fetchAllGroups` on Evolution.

## Operations

```sh
systemctl status evolution-api stewie
journalctl -u stewie -f
```

Both services restart automatically. Stewie stores state in `data/state.json` (mode `0600`); Evolution stores the WhatsApp session in Postgres, so the pairing survives restarts.

## Risks and limits

This is an unofficial WhatsApp transport. Know the trade-offs before putting a primary number on it:

- **Ban risk.** WhatsApp bans numbers that use unofficial automation. The paired number is `+27747778886`, a primary number with existing groups. Keep the reply rate low, do not run it in unrelated groups, and be ready to re-link.
- **The bot speaks as you.** Replies are indistinguishable from your own messages to everyone in the chat.
- **Terms of service.** Using a non-official client violates WhatsApp's terms and is not suitable for business messaging or for a product sold to customers. It is fine for personal use.
- **Fragility.** Baileys breaks when WhatsApp changes protocol; you own the patching.
- **Credential exposure.** The Evolution instance holds a full WhatsApp session. `.env` and the Evolution database are secrets.
- **Privacy.** Message text is sent to the configured model provider and stored locally for `STEWIE_RETENTION_DAYS`. Logs contain hashed ids, not message bodies.

## Not built

- No web UI — the admin API is the interface.
- No image understanding, no voice notes, no multi-language routing.
- No per-chat knowledge base; context is the rolling chat history.
- No outbound campaigns; Stewie only replies to inbound messages.

---

## Attribution notice

This deployment uses **Evolution API** (https://github.com/evolution-foundation/evolution-api),
licensed under Apache 2.0. Evolution API is being utilised as the WhatsApp transport
for Stewie. The upstream logo and copyright information in the Evolution API console
have not been removed or modified.
