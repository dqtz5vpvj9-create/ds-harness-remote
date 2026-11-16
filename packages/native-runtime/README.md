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

The `remote/service` entry point registers the authenticated source, workspace,
upload, navigation and terminal services. Storage paths and receipt formats are
unchanged. It requires the resource-owned terminal factory from the DSH extension
SDK. HHPI pins this SDK in `UPSTREAMS.json` (DSH `0.2.2-rc.1`, extension
`hhpi-dsh-022-20261107.29`); its bundle installer verifies and overlays that SDK
in the shared runtime closure. The vanilla npm package with the same version
does not supply this factory. Enabling a local source workspace without it fails
before source registration, rather than advertising a non-working terminal.
The core Codex entry point does not require this extension. The port in
`workspace/terminal-owner` checks the SDK export and contains no PTY execution
implementation. Host integration tests must run against the pinned SDK, as well
as checking that a plain SDK is rejected before installation.

For a fresh Remote checkout, prepare the pinned SDK after the workspace install:

```sh
node scripts/prepare-native-sdk.mjs /path/to/isolated-sdk
pnpm --filter ./packages/native-runtime build
pnpm --filter ./packages/native-runtime test
```

Run these commands from the repository root. The helper verifies the published
archive and package checksums, installs the exact SDK lockfile into the supplied
directory, and changes only this package's SDK links. It never modifies the
workspace pnpm store or the Plugin's default SDK. Source and license materials
remain with the isolated SDK. CI uses the same procedure. An optional second
argument supplies an offline archive with the same required checksum.

The cross-package network contract is `tests/native-multihost-network.test.ts`:
it runs the actual self-hosted Server, Host/Client runtimes and encrypted relay,
with a synthetic execution boundary and the production durable receipt ledger.
It covers loss of A's accepted response while B stays usable and A reconnects;
it does not constitute provider, browser or device acceptance.
