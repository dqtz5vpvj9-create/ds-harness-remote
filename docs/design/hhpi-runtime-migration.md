# HHPI shared runtime migration

The fork owns generic remote connections, native-agent adapters, source history,
receipts, files and terminals. DSH Web and DSH Go retain their official UI. HHPI
retains distribution configuration, legacy identity compatibility and workspace
policy. Upstream changes are integrated into this fork after behavior checks;
upstream acceptance of our changes is not required for release.

## Pinned starting points

| Repository | Revision |
| --- | --- |
| Remote upstream | `f8e62202b709240452e5cc0c8924c2e67d73521c` |
| HHPI | `28076c7a35adc4f62bacab6a82b786193942b9a8` |
| DSH Go | `a08c06f04bd4f90035cab1231c8470e764df69e0` plus the saved HHPI integration patch |

The Go patch and HHPI pre-existing documentation edits must be preserved. A
newer upstream Go revision is a separate integration decision, not permission
to overwrite the delivered baseline during this migration.

## Capability ownership and acceptance

| Existing behavior | Shared implementation | User entry | Required contract / acceptance |
| --- | --- | --- | --- |
| Native model, effort, Fast, permissions, plan mode | `native-runtime/src/remote/codex-access-bridge.ts` and method policy | Existing Web/Go model and permission selectors | Original thread settings/readback; no provider API-key detour |
| Send, queue, steer, interrupt | `codex-adapter.ts`, `codex-queue-steer.ts`, `operation-ledger.ts` | Composer and queue | Send/receipt contracts; receive-with-lost-ACK, restart and attachments; one writer |
| Approval and structured questions | `codex-async-questions.ts`, `codex-pending-history.ts`, access bridge | Native approval/question cards | Pending/async-question contracts; transport loss never means decline; stale native generation rejected |
| Complete native history | `codex-history.ts`, `codex-metadata-core.mjs`, `event-index.ts` | Reader and history navigation | Exact paged body/image/tool comparison; stale cursors rejected; failed read preserves body |
| Command, file changes, plan and usage | `codex-presentation.ts`, `codex-history.ts`, tool details | Official tool/detail views | Rich-content/presentation contracts plus actual Web/Go screenshots; unknown is not zero |
| Files, directories and terminal | Source workspace registrations and Remote workspace bridges | New-chat picker, files, terminal | Verify session owner on Windows/Linux; no central-host path fallback |
| Multiple simultaneous hosts | Negotiated `remote.multi-host.v1`; shared account control and independent links | Unified machine/sidebar and panes | B never replaces A; reconnect A while B continues; independent Noise and replay state |
| Antigravity | Existing ACP adapter with explicit history failures | Same source/session entries | Real subscription send and history recovery; advertise only verified capabilities |
| Existing links and data | Canonical source IDs and existing data roots | Saved sessions | Keep native IDs, attachment references, receipts; no forced session recreation |

The extracted package is not itself a transport cutover. The old writer stays
active for a source until the new complete user path passes. There must never
be two mutation executors for one operation. Delete replaced HHPI runtime code
only after consumers use this package and the replacement path is verified.

## Rollout and rollback

1. Establish the current behavior and preserve current changes.
2. Consume the shared native runtime in both Remote and HHPI.
3. Connect TS and Dart clients through one account control connection with
   independently owned host links and session-pinned routing.
4. Verify every existing Web/Go entry, Antigravity, weak-network receipt
   recovery and native history. A successful RPC is not UI acceptance.
5. Switch sources individually after their running tasks finish; remove unused
   implementations only after the active call graph confirms replacement.

Retain two verified release versions and a source routing rollback. Rollback
must reuse source identity and the same receipt store; it cannot undo an
already accepted native operation or replay an uncertain send. Compare latency,
history reading and memory on the same machine/data/network before switching.
Live acceptance evidence belongs in ignored artifacts, not this design document.

## Following upstream

The owned fork uses `hhpi-runtime` as its default branch. The upstream integration
workflow checks release tags daily and checks unreleased main changes each
Monday; it can also be dispatched manually. It merges into a disposable CI
checkout and runs the combined protocol, crypto, transport, native-runtime and
installation checks. Conflicts and a Git bundle of a mergeable candidate are
retained as workflow artifacts. It has read-only repository permissions and
does not change the distribution branch, create a PR or deploy a candidate.

After CI succeeds, import the candidate into an integration branch and run the
Web/Go behavior and native-source acceptance against the current distribution.
Only then promote the candidate. A green candidate build alone cannot replace
the weak-network, source-identity, approval or interface acceptance requirements.
