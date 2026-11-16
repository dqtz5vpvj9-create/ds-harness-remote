# Native runtime

This package owns the source-side Codex implementation shared by Remote and
HHPI. It preserves native thread identity, durable operation receipts, native
history, pending requests and the DSH event projection. It does not start a DSH
execution session to represent a native agent session.

`DirectCodexAdapter` owns one configured native source. `SourceGateway` routes
canonical source/session identities and accepts a carrier-supplied authorization
function for each request. A session grant does not confer source-wide native
RPC access. A transport reconnect must not dispose the adapter or synthesize an
approval decision. Disposing a view only cancels that reader.

```ts
import { DirectCodexAdapter, SourceGateway } from '@dsh-remote/native-runtime';

const source = new DirectCodexAdapter(configuration, existingSourceDataDirectory);
const gateway = new SourceGateway([source]);
// Supply the authenticated carrier's current grants, never an unconditional
// allow callback for remote callers.
const page = await gateway.read(request, grants, signal);
```

Writes require the original stable operation ID. Query an uncertain receipt;
do not assign a new ID and resend. A history page is a bounded window; follow
its cursors and epoch to read the full history. A failed read does not revoke
the last accepted page. An unknown measurement remains unknown.

Native requests retain their native connection generation. Client transport
reconnection can recover pending requests, while replies from an obsolete
native generation cannot be dispatched. The reviewed method inventory is a
dispatch policy, not a claim that every method is available in every runtime.

The package includes its source, build configuration, helper programs and
behavior contracts. `pnpm build` builds the library; `pnpm test` runs the
contracts. Set `HHPI_CODEX_TEST_COMMAND`,
`HHPI_CODEX_ASYNC_QUESTION_TEST_COMMAND`, `HHPI_CODEX_QUEUE_START_TEST_COMMAND`
and `HHPI_CODEX_PENDING_TEST_COMMAND` to the pinned native executable for the
isolated native-process tests. These tests use a synthetic model service and
separate native homes; they do not prove real-provider or device acceptance.

See [NOTICE.md](NOTICE.md) for the original source revision and AGPL license.
