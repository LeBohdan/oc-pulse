# Fix: TaskSnapshot missing totalMs and totalTokens

## Problem
`TaskSnapshot` type (tui.tsx:47-48) requires `totalMs: number` and `totalTokens: number`, but two object literals don't include them:

1. **`slot_selected` handler** (tui.tsx:270) — creates `currentTask` without these fields
2. **`task_started` handler** (tui.tsx:293) — same issue

## Fix
Add `totalMs: 0, totalTokens: 0` to both object literals.

### Rationale
- These values are updated later via `generation_complete` / `task_finished` events (tui.tsx:350-351, 376-377)
- Display logic already has fallbacks: `last.totalMs || s.durationMs` (tui.tsx:162) and `last.totalTokens || last.generatedTokens` (tui.tsx:164)

### Changes
**tui.tsx:282** — after `updatedAt: Date.now(),` insert:
```ts
        totalMs: 0,
        totalTokens: 0,
```

**tui.tsx:306** — after `updatedAt: Date.now(),` insert:
```ts
        totalMs: 0,
        totalTokens: 0,
```

### Alternative
Make `totalMs` and `totalTokens` optional in `TaskSnapshot` type, but initializing to 0 is cleaner since the type already expects numbers.
