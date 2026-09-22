# Prompt Pocket MVP specification

Status: this document defines the public technical contract implemented by `desktop/plugin.js`.

## 1. Scope and workflow

Prompt Pocket uses a manual copy and paste workflow:

- Saving starts from **Prompt library**, then **New prompt**, which opens an editor where the user manually pastes prompt text.
- Using a saved prompt copies its exact text; the user manually pastes it into the composer.
- There are no draft reads, insertion APIs, caret operations, replace actions, send actions, or composer middleware.

Prompt Pocket is a reusable prompt library, not session history, agent memory, automatic context injection, or a secrets manager.

## 2. Plugin surface

Stable plugin ID: `prompt-pocket`. Runtime deliverable: the plain ESM [`desktop/plugin.js`](./desktop/plugin.js), packaged with the root `plugin.yaml` manifest. It imports only `@hermes/plugin-sdk`, `react`, and `react/jsx-runtime`, and contains no JSX syntax.

The plugin contributes:

- one icon-only library button in `TITLEBAR_AREAS.right`, with tooltip and accessible label **Prompt pocket**, opening the existing library; no composer controls;
- matching palette action `prompt-pocket.open-library`;
- matching rebindable keybind action with `defaults: []`;
- one permanently mounted, visually empty dialog controller in `titleBar.center` so all entry points share the same state.

All dialogs use the SDK UI kit. Search receives focus after data loads. Up/Down changes selection, Enter copies the selected prompt, Escape closes through the dialog primitive, and multiline editor Enter remains a newline. Preview is rendered as plain text. Dirty prompt and import editors require discard confirmation on close/navigation.

## 3. Data contract

The v1 document is used for IndexedDB and JSON export/import:

```json
{
  "schemaVersion": 1,
  "prompts": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "Review code",
      "text": "Review this code.\n",
      "createdAt": "2026-09-21T12:00:00.000Z",
      "updatedAt": "2026-09-21T12:00:00.000Z"
    }
  ]
}
```

Validation is strict and whole-document:

- only the documented fields are accepted;
- `schemaVersion` must equal `1`, `prompts` must be an array, and IDs must be unique UUIDs;
- names are trimmed on create/edit and stored names must be nonblank without surrounding whitespace;
- text must contain non-whitespace content but is stored otherwise unchanged;
- timestamps must be canonical UTC ISO strings and `updatedAt >= createdAt`;
- edit retains ID and creation time and only advances modification time when name or text changes;
- malformed storage and unsupported schema are errors, never empty-library fallbacks.

## 4. IndexedDB persistence contract

Chosen store:

| Item | Value |
| --- | --- |
| Database | `prompt-pocket` |
| Version | `1` |
| Object store | `documents` |
| Key | `library` |

`ctx.storage` is prohibited for this implementation because its fallback behavior masks JSON parse failures.

Each mutation is a single IndexedDB `readwrite` transaction on the document store:

1. Read the current `library` value.
2. Treat only an absent key (confirmed by `count`) as an empty v1 document. A present `undefined` value is malformed data.
3. Validate the complete current document.
4. Apply one synchronous mutation to an isolated next document.
5. Validate the complete next document.
6. Issue one `put` and announce success only after transaction completion.

IndexedDB serializes conflicting read/write transactions against the same origin/database/store, so two windows cannot both commit from the same pre-write state and silently lose an addition. Edits/deletes additionally compare the exact opened record snapshot; confirmed import compares the exact previewed document. A mismatch throws a stale-operation error before writing.

The object store is never deleted for recovery. A transaction error or validation exception aborts without publishing success. On database version change the connection closes. Plugin unload closes its connection and optional `BroadcastChannel`; the latter only prompts other windows to refresh.

## 5. Workflows

### Create and edit

The user supplies a name and manually pasted text. Create always adds a UUID record; duplicate names are allowed. Edit preserves identity and creation time. Closing dirty content requires explicit discard. Save failure leaves the editor and input visible.

### Search, preview, and copy

Search is a case-insensitive literal substring match over name or text. Empty search returns all records, sorted by `updatedAt` descending and then ID ascending. Copy first calls `ctx.os.writeClipboard`. A `false` result or exception reveals a readonly textarea containing the exact text and a **Select text** action. Copy never sends or alters a draft.

### Delete

Delete requires confirmation naming the prompt. It removes exactly one snapshot-matched record. Failure or staleness keeps the record visible and reports an error.

### Export and import

Export serializes the complete validated v1 document as indented JSON with a final newline, then uses clipboard/manual selection. No filesystem or backend path is used.

Import accepts explicitly pasted JSON. The complete input is parsed and validated before preview. Merge is additive:

- same ID and identical record: skip;
- same ID and any differing field: retain existing, import a copy with a fresh UUID;
- different ID: retain both, even for duplicate content/name.

Preview reports additions, identical skips, and collision copies. Preview is non-mutating. Apply rechecks the complete current document in its write transaction; any intervening change requires a new preview. Apply performs one whole-document write. Cancel/discard performs no write.

## 6. Security and boundaries

- No backend, REST, socket, gateway RPC, model call, fetch, or send action.
- No transcript action, DOM injection, private import, Hermes source/config edit, or auto-install.
- Prompt contents enter neither chat context nor agent memory until the user manually pastes them.
- Clipboard/export data is plaintext and may contain sensitive text; Prompt Pocket is not a credential vault.
- Preview renders text, never trusted HTML.

## 7. Storage scope and limitations

The database is scoped to the browser/Desktop webview origin and local application data. Same-origin windows share IndexedDB transactions. This does not promise portability or synchronization across client installations, computers, application-data resets, origin changes, webview migrations, or every Hermes profile/package configuration.

The host/browser controls physical location, quota, eviction, backup participation, and at-rest protection. Important libraries require user-managed plaintext JSON exports. No claim is made that the data lives in a user-visible `prompts.json` file or on a Hermes backend.

## 8. Verification requirements

Dependency-free Node tests must cover validation, exact string preservation, import policy, search ordering, CRUD failures, missing versus malformed storage, write failure atomicity, concurrent transactions, stale edits/imports, SDK registrations, empty default keybinds, cleanup, and absence of send/network calls.

Mock/VM results must be labeled as such. A real browser check, when executable, establishes browser IndexedDB behavior only. Live Hermes Desktop remains required to verify actual UI layout, focus restoration, keyboard interaction, clipboard bridge behavior, enable/disable/hot reload, persistence across app restart, and the host webview's concrete origin/profile behavior. Do not claim those checks without running them.
