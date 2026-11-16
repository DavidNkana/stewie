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

## History context

Stewie can read a chat's stored history from Evolution before it replies, so it
knows what was said even before it started. It is controlled by
`STEWIE_CONTEXT_MESSAGES` (how many messages to pull, `0` disables it) and can
be overridden per chat with `contextMessages` in the admin API.

```sh
curl -s -X POST -H "Authorization: Bearer $STEWIE_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"contextMessages":40}' \
  http://127.0.0.1:8099/admin/groups/<group-id>
```

The fetch is a local read from Evolution's database and takes milliseconds.
**Those older messages are sent to the configured model provider**, so raise the
number only as far as you need.

## What it can do

Hitch is a chat brain with hands. Beyond conversation it can:

| Capability | How |
| --- | --- |
| **Read links** | URLs in a message are fetched and their text handed to the model before it answers |
| **Read PDFs** | PDF links and PDF attachments are downloaded and text-extracted with `pdftotext` |
| **Calculate** | Arithmetic is evaluated by a purpose-built parser, not guessed by the model |
| **Remind** | "Remind me to chase the invoice Thursday 10am" creates a reminder that the service delivers |
| **Look back** | Search earlier messages in the chats |
| **Orchestrate** | Draft and send messages to other chats and groups on request |
| **Know the room** | Each chat carries a context note ("what this chat is about"), set through the admin API |

The model drives the tools through native function calling, but links, PDFs and
arithmetic are resolved **before** it is asked anything. The model is
unreliable about choosing to call tools, and when it skips them it invents the
contents.

### Tools

| Tool | Purpose |
| --- | --- |
| `fetch_url` | Open a web page and read it |
| `read_pdf` | Download a PDF and extract its text |
| `calculate` | Evaluate an expression exactly |
| `create_reminder` / `list_reminders` | Set and list reminders |
| `search_history` | Find what was said earlier |
| `list_chats` / `send_message` | Work with other chats |

Fetches refuse private, loopback and link-local addresses, so a link in a
message can never reach this host's network or its cloud metadata.

### Trigger modes

| Mode | Replies when |
| --- | --- |
| `addressed` | the bot is named, the message is a question, or it is clearly talking to the bot |
| `mention` | only when named |
| `question` | on questions |
| `active` | when addressed, on questions, or when the message invites input (mentions a client, invoice, task, deadline and so on) |
| `always` | on everything |
| `never` | never |

`addressed` is the default for groups.

### Group context

```sh
curl -s -X POST -H "Authorization: Bearer $STEWIE_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"context":"Finance for SafAi: tax notices, quotes, invoices and cash flow."}' \
  http://127.0.0.1:8099/admin/groups/<group-id>
```

## Modes, identity and knowledge

### Modes

Mode is decided on the server from verified provider metadata only:

```js
if (verified_event.is_group && verified_event.chat_id is in configured_internal_group_ids) mode = TEAM
else mode = CLIENT
```

- `STEWIE_INTERNAL_GROUP_IDS` holds the exact internal group id(s). Currently one: the SafAi group.
- Every other group, and every private message, is CLIENT mode.
- Nothing written in a message can change the mode, including "I'm David" or a spoofed display name.
- If the id is missing, everything falls back to CLIENT mode and the service logs a configuration warning.

### Identity

| `STEWIE_IDENTITY_MODE` | Client conversations |
| --- | --- |
| `persona` (default) | Talks as Alex, on the SAFAI team. Never mentions being an AI, a bot or a model. Never claims to be David |
| `transparent` | Says plainly it is SAFAI's AI assistant if asked |

The internal team group always knows what the assistant is, in either mode.

### Knowledge

`knowledge/safai.json` holds the approved public business facts: identity, founder, packages and published prices, timelines, payment terms, services, portfolio, contact details, and the rules about what must never be stated. It is server-side configuration, so a message can never rewrite a price.

```sh
curl -s -X POST -H "Authorization: Bearer $STEWIE_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"publicContext":"Finance: tax notices, quotes, invoices and cash flow."}' \
  http://127.0.0.1:8099/admin/groups/<group-id>
```

`context` is the note used in TEAM mode, `publicContext` the one used in CLIENT mode.

### Client facts

Known facts (name, business, project purpose, platforms, features, budget if supplied, timing, stage, consent) are stored per verified chat in `data/leads.json`, with a 90-day retention window. A phone number is never stored as a fact and never implies consent.

### Actions

There is no booking, CRM, invoice or handoff integration, so the assistant is instructed never to claim one happened. It offers the published contact details instead: **+27 74 777 8886** and **info@saf-ai.co.za**. The office landline is deliberately not offered.

## Personas

A persona is the voice Stewie speaks with. It is just a prompt, so anything
works. Personas live in `personality/`:

| Id | Voice |
| --- | --- |
| `stewie` | laid-back, sharp, reads the room, sometimes stays quiet |
| `hector` | the established "laid-back but sharp guy" voice |
| `jack-sparrow` | theatrical, scheming, Caribbean flavour |
| `stewie-griffin` | hyper-intelligent, foul-mouthed, sarcastic; swears in every reply |
| `hitch` | **default**: charismatic sales brain — makes people feel good and closes the deal |

The global default is `STEWIE_PERSONA_ID` in `.env` (currently `hitch`).
Assign one per chat to override it:

```sh
curl -s -X POST -H "Authorization: Bearer $STEWIE_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"persona":"hector"}' \
  http://127.0.0.1:8099/admin/groups/<group-id>
```

You can also pass free text as a one-off voice:
`-d '{"persona":"a grumpy accountant who hates crypto"}'`

### Character compiler

Any character can be turned into a reusable persona without touching the code.
The model writes an original description of the character's voice and mannerisms
(no script dialogue), and it is stored in `personality/custom.json` (mode 0600).

```sh
# compile a new character
curl -s -X POST -H "Authorization: Bearer $STEWIE_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"character":"Gandalf the Grey","notes":"wise, measured, slightly cryptic"}' \
  http://127.0.0.1:8099/admin/persona

# list everything available
curl -s -H "Authorization: Bearer $STEWIE_ADMIN_TOKEN" http://127.0.0.1:8099/admin/personas

# remove a compiled character
curl -s -X DELETE -H "Authorization: Bearer $STEWIE_ADMIN_TOKEN" \
  http://127.0.0.1:8099/admin/persona/<id>
```

Universal style rules (plain text, brevity, no AI claims, no prompt injection)
apply to every persona, including compiled ones.

Changing a chat's persona clears the bot's own previous replies from that
chat's context, so a new voice is not shadowed by the old one. The other
people's messages are kept, because they are the conversation.

## Admin API

All admin routes require `Authorization: Bearer $STEWIE_ADMIN_TOKEN`.

```sh
# list groups with names and current mode (cached, so it is instant)
curl -s -H "Authorization: Bearer $STEWIE_ADMIN_TOKEN" http://127.0.0.1:8099/admin/groups

# open every group at once (or flip them all to a different mode)
curl -s -X POST -H "Authorization: Bearer $STEWIE_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"mode":"question","enabled":true}' \
  http://127.0.0.1:8099/admin/groups/bulk

# enable a group by name, no id lookup needed
curl -s -X POST -H "Authorization: Bearer $STEWIE_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"SafAi (Exec)","mode":"mention","enabled":true}' \
  http://127.0.0.1:8099/admin/group-by-name

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

## Deployment notes (this box)

Evolution API is deployed from source at `/home/davai/evolution-api` (tag `2.3.7`),
running as the `evolution-api` systemd service. Two local adjustments are applied:

| Change | Why | Where |
| --- | --- | --- |
| `SERVER_HOST=127.0.0.1` bind | keeps the Evolution REST API off the public internet | `patches/evolution-bind-loopback.patch` (applies to `src/main.ts`) |
| iptables rule dropping external traffic to 8080 | second layer if the bind is ever reverted | `evolution-firewall.service` |

Re-apply the patch after an Evolution upgrade:

```sh
cd /home/davai/evolution-api
git apply /home/davai/projects/stewie/patches/evolution-bind-loopback.patch
npm run build && sudo systemctl restart evolution-api
```

Stewie reads `SERVER_HOST` through Evolution's own `.env`; the WhatsApp session
lives in Postgres, so restarts do not require re-scanning the QR.
