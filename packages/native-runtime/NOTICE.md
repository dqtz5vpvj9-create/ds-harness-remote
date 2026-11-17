# Source and license

The native runtime was extracted from HHPI (`dqtz5vpvj9-create/hapi-dsh`),
revision `28076c7a35adc4f62bacab6a82b786193942b9a8`, under AGPL-3.0-only.
The original copyright and license remain applicable. The enclosing Remote
repository contains MIT-licensed upstream code; that does not relicense this
package. Consumers distributing a combined work must retain both notices and
comply with the AGPL terms.

Native thread identifiers, on-disk receipt formats, attachment references and
source-session IDs are retained for compatibility. Extraction does not move or
replay native operations.

The Web carrier in `src/web/` also incorporates HHPI's bounded HTTP/WebSocket
forwarder from revision `3ed29f276`. It retains AGPL-3.0-only licensing. Remote
supplies the authenticated encrypted connection; no native execution is moved.
