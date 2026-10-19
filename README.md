# WhatsApp Luna Bot — validation MVP

Validation MVP for testing whether a fast, friendly 1:1 WhatsApp assistant creates repeat usage. It is dependency-free Node.js for the official Meta WhatsApp Cloud API, uses an OpenAI-compatible `/chat/completions` endpoint, and keeps short local conversation history. It is not production-ready.

## Quick start

Requires Node 18+ (built-in `fetch`). Explicitly set `MOCK_MODE=true` for the local/test path; mock mode intentionally bypasses live Meta delivery and may accept unsigned test webhooks. Live/non-mock mode fails closed unless both webhook secrets are configured.

```sh
cd /home/davai/projects/stewie
MOCK_MODE=true OPENAI_API_KEY=... WEBHOOK_VERIFY_TOKEN=choose-a-secret npm start
```

For a live bot, set all of `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `META_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN`, and `OPENAI_API_KEY`. Keep secrets outside source control. POST webhooks with a configured app secret must include a valid Meta `X-Hub-Signature-256`; GET verification requires `hub.mode=subscribe`, the exact token, and a nonempty challenge. Live payloads must include metadata whose `phone_number_id` exactly matches the configured ID.

## Meta setup

1. Create a Meta developer app, add the WhatsApp product, and use a test business phone number.
2. Create a permanent/system-user access token with permission to send WhatsApp messages; note the phone number ID.
3. Configure the app Webhooks product with a public HTTPS callback such as `https://your-host.example/webhook`, the same verify token, and subscribe to `messages`.
4. Subscribe the WhatsApp business account to the app and message the test number from an allowed user.
5. Set the app secret so inbound requests are authenticated. The service acknowledges valid webhooks before model/Graph API work.

For local development, expose port 3000 with a tunnel (for example `ngrok http 3000` or Cloudflare Tunnel) and register the HTTPS URL plus `/webhook` in Meta.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `WEBHOOK_VERIFY_TOKEN` | empty | Meta GET verification token |
| `META_APP_SECRET` | empty | HMAC validation; required in live/non-mock mode |
| `WHATSAPP_ACCESS_TOKEN` | empty | Meta Graph API bearer token |
| `WHATSAPP_PHONE_NUMBER_ID` | empty | Sending phone number ID |
| `GRAPH_API_VERSION` | `v23.0` | Graph API version |
| `OPENAI_API_KEY` | empty | Model API key |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible API base |
| `OPENAI_MODEL` | `gpt-5.6-luna` | Chat model |
| `MOCK_MODE` | `false` unless explicitly set | Test-only path: log replies instead of sending; do not use as live authentication |
| `STATE_FILE` | `./state.json` | Local JSON state path |
| `RETENTION_DAYS` | `7` | Bounded local retention for processed IDs, opt-outs, and conversation entries |
| `RETRY_ATTEMPTS` | `2` | Internal model/send attempts per message |
| `RETRY_DELAY_MS` | `25` | Delay between internal attempts |

## Useful curls

```sh
curl 'http://localhost:3000/health'
curl 'http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=choose-a-secret&hub.challenge=test'
```

Run tests with `npm test`.

## Guardrails and validation limitations

- `STOP` and `UNSUBSCRIBE` opt a phone number out; subsequent messages are ignored. This implementation does not proactively contact users.
- The model prompt declines sensitive-domain advice. This is a basic guardrail, not a compliance system; add review, policy, and escalation before high-stakes use.
- State is a local JSON file intended for one small process. It contains phone numbers, message IDs, opt-out state, and short conversation history, pruned by `RETENTION_DAYS` (default 7) on load/save. Messages are sent to the configured model provider and retained locally for that period. This is a user-facing disclosure, not a claim of production privacy compliance; there is no multi-user access control, encryption, deletion workflow, or backup.
- Only inbound individual text messages are handled. Statuses, media, reactions, and other message types are ignored.
- Arbitrary existing WhatsApp groups are unsupported. Official WhatsApp Groups API access has eligibility, group creation, participant, and policy constraints; it is not a general way to attach a bot to any existing group. Validate current Meta documentation and eligibility before planning group workflows.
- Per-sender ordering, bounded request/body parsing timeouts, in-flight duplicate handling, and bounded retry-safe completion are implemented for this single process. An ambiguous provider timeout can still produce duplicate external delivery because Meta has no client idempotency in this MVP. Rate limits, dead-letter handling, multi-instance locking, durable queues, and production observability are out of scope. Do not claim production readiness.

## Business hypothesis and measurement

**Hypothesis:** people who receive a useful answer to their first WhatsApp question will send another question within 7 days. The validation target is repeat-user rate, not message volume. JSON events (`inbound_accepted`, `reply_success`, `model_latency`/`model_error`, `send_latency`/`send_error`, `processing_error`, and `opt_out`) contain message IDs, hashed users, attempts, errors, and latency without message contents or full phone numbers. Use them to measure activation (`reply_success`), repeat usage by hashed user, successful replies, opt-outs, failure rate, and latency; add provider token/cost data before making cost claims. This is a validation MVP: revenue model and paying customer remain unvalidated.
