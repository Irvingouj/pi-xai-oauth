# Local fork notes

**Intent:** SuperGrok **cli-chat-proxy only** — no `api.x.ai`, no `xai_*` tools.

## Models (`xai-auth`)

| Model ID | CLI proxy | Tool shims |
|----------|-----------|-------------------------------------|
| `grok-4.7` | ✅ | ❌ (Pi native `grep`/`bash`/`read`) |
| `grok-4.7-build-fast` | ✅ (Grok 4.7 Fast, 2× token rates) | ❌ (Pi native tools) |
| `grok-4.6` | ✅ (default) | ❌ (Pi native `grep`/`bash`/`read`) |
| `grok-4.5` | ✅ | ❌ (Pi native tools) |
| `grok-build` | ✅ | ❌ (Pi native tools) |
| `grok-composer-2.5-fast` | ✅ | ❌ (Pi native tools) |

All traffic: `https://cli-chat-proxy.grok.com/v1` + `x-grok-model-override`.

Reasoning (match Grok CLI `xai-org/grok-build`, not omp's xai-oauth strip):

- Always `include: ["reasoning.encrypted_content"]` on Responses (`apply_response_defaults`).
- Replay typed `reasoning` items with `encrypted_content` verbatim. That blob is what restores exact tokens server-side and keeps the prefix cache stable.
- `status` is output-only; strip it on input. Content parts need `type: "reasoning_text"`.
- `grok-4.7`, `grok-4.7-build-fast`, and `grok-4.6` efforts: `low` / `medium` / `high` / `xhigh`. `grok-4.5`: `low` / `medium` / `high` (`xhigh` clamps to `high`). `minimal` → `low`. `max` → highest advertised (`xhigh` or `high`).
- Encrypted-content decrypt failures are a new-session error, never a retry.

OAuth login: `https://auth.x.ai` only.

## Apply

```text
/reload
/model grok-4.6
```
