# Local fork notes

**Intent:** xAI OAuth + **Grok 4.5** (and other API models) for **pi native tools**.

## Removed vs upstream npm `pi-xai-oauth`

- No Cursor/Grok CLI tool shims (`Grep`, `Shell`, `Read`, `Write`, …)
- No `grok-composer-2.5-fast` / `grok-build` model entries (CLI-proxy models)
- No `syncCursorToolShimsForModel` lifecycle hooks

Want Composer / Grok CLI tool surface? Use **Grok CLI**, not this package.

## Install

```bash
pi remove npm:pi-xai-oauth   # if still on npm
pi install /Users/oujunyi/code/pi-xai-oauth
```

Settings should list `/Users/oujunyi/code/pi-xai-oauth` (path), not `npm:pi-xai-oauth@…`.

Default model: `grok-4.5` + provider `xai-auth`.

## Coexists with

`~/code/pi-extensions` — policy overrides for built-in `grep` / `bash` / `read` only.
