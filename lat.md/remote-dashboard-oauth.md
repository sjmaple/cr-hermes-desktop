# Remote Dashboard OAuth

Direct Remote mode detects browser-authenticated Hermes dashboards and connects without exposing OAuth credentials to renderer code.

## Authentication selection

The public dashboard status endpoint and raw-gateway health endpoint select token or OAuth behavior automatically for direct Remote connections.

[[src/main/remote-oauth.ts#probeRemoteAuthMode]] reads `/api/status`; `auth_required: true` selects OAuth. A `404` or `405` then probes `/health` with the supplied `API_SERVER_KEY`: a healthy response or an explicit `401`/`403` identifies the raw token gateway. Other probe failures remain errors rather than transport guesses.

Configured reverse-proxy URL credentials become Basic headers for both discovery routes, with encoded userinfo decoded before transmission. Public status never receives the dashboard token; raw health retains Bearer authentication when no proxy credentials are configured.

The first-run `connect-remote-gateway` operation in [[src/main/ipc/register.ts#registerIpcHandlers]] owns detection, authentication, validation, and configuration commit as one main-process transaction. OAuth opens the dedicated login window before saving; token mode verifies `/health`; either failure leaves the previous connection configuration untouched. [[src/renderer/src/screens/Welcome/Welcome.tsx#Welcome]] surfaces that single operation and explains that the remote key comes from `API_SERVER_KEY` in the remote `~/.hermes/.env`.

The public startup probe uses `/api/status` without a stored token after OAuth is selected, avoiding the authenticated `/health` redirect and stale-token false negatives.

## Node system certificate trust

Main-process Node HTTPS and onboarding fetch include trusted operating-system roots without weakening certificate or hostname verification.

[[src/main/system-ca-trust.ts#initializeSystemCertificateTrust]] unions `tls.getCACertificates("default")` with `"system"` and installs the deduplicated result. Existing bundled, extra, and custom defaults remain trusted. The side-effect import is first in [[src/main/index.ts]], before consumers can cache TLS sessions. Electron cookie-backed OAuth transport is unchanged.

Both APIs are feature-detected. Older development Node runtimes retain their existing defaults; a system-store lookup or setter failure logs a warning and keeps verification enabled. The packaged Electron 44 runtime supports the APIs. Node documents the getter from 22.15 and the setter from 22.19 (also 24.5) in its [TLS API reference](https://nodejs.org/api/tls.html#tlssetdefaultcacertificatescerts). Trust changes apply to the main thread; no OS trust store or user configuration is modified.

A private/self-signed root must already be trusted by the operating system or supplied through supported Node extra-CA configuration. Arbitrary untrusted endpoints still fail. Native OS-store installation is outside the isolated regression proof.

## Credential boundary

OAuth cookies live only in a dedicated persistent Electron session owned by main process.

[[src/main/remote-oauth.ts#REMOTE_OAUTH_PARTITION]] identifies `persist:hermes-remote-oauth`. [[src/main/remote-oauth.ts#openRemoteOAuthLogin]] opens sandboxed `/login`; preload exposes only login, logout, probe, and signed-in state.

[[src/main/remote-oauth.ts#requestRemoteOAuthJson]] uses Electron `net` with that session and `useSessionCookies: true`. Cookies, refresh tokens, and WebSocket tickets never enter renderer state or desktop configuration.

After the browser flow returns, [[src/main/remote-oauth.ts#connectionConfigAfterRemoteOAuthLogin]] re-reads the current configuration. It commits OAuth mode only when Remote mode and the normalized gateway URL still match, preserving newer settings.

[[src/main/hermes.ts#getRemoteAuthHeader]] suppresses stored Remote bearer keys whenever OAuth is selected. The key may remain saved for later token mode, but OAuth chat and auxiliary requests cannot reuse it.

## WebSocket ticket lifecycle

Every OAuth WebSocket attempt receives a new single-use ticket immediately before connection.

[[src/main/dashboard.ts#freshDashboardWebSocketUrl]] calls [[src/main/remote-oauth.ts#mintRemoteOAuthWsTicket]] for OAuth connections. Readiness probing consumes its own ticket; renderer reconnects request another through bounded IPC.

For non-loopback HTTP gateways, [[src/main/dashboard-websocket-relay.ts#createLoopbackWebSocketRelay]] proxies one WebSocket through a random-capability loopback URL. The renderer CSP permits loopback WebSockets, never arbitrary `ws:` origins.

## Session data routing

Remote session history uses the same selected authentication transport as management APIs.

[[src/main/remote-sessions.ts#remoteRequestJson]] routes direct OAuth session lists, search, messages, media, titles, and deletion through the persistent cookie partition. Token and SSH session requests send `X-Hermes-Session-Token` plus `Authorization: Bearer` for gateway compatibility. When the configured URL contains Basic credentials for a reverse proxy, Node supplies Basic authorization and the dashboard still receives its separate session-token header. The gateway API key and dashboard session token remain distinct credentials; adding a header does not make them interchangeable.

## Authenticated management request boundary

Direct Remote management features share one main-process request client that selects cookie or token authentication without exposing reusable credentials through IPC.

[[src/main/remote-api.ts#remoteDashboardRequestJson]] resolves `auto` through the public status probe, routes OAuth through the persistent Electron partition, and routes token mode through the shared session request client with the same Bearer/Basic handling. Unexpected probe failures never guess another transport or fall back to local state.

[[src/main/remote-api.ts#RemoteDashboardApiError]] normalizes HTTP status for feature adapters. A `404` marks only that feature unsupported; OAuth login-required errors retain their original reauthentication signal.

## Failure behavior

Missing or expired OAuth sessions stop Remote chat and request browser sign-in without falling back to local state or legacy `/v1`.

[[src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts#useDashboardChatTransport]] marks OAuth login-required errors as dashboard-reachable failures. Settings hides Legacy transport for OAuth and provides Sign in and Sign out actions.

## Auxiliary feature authentication

Remote Skills uses cookie-aware fetch, while MCP uses the authenticated management request boundary. Both retain the selected profile and keep credentials in the main process.

[[src/main/remote-oauth.ts#remoteAuthFetch]] accepts the connection snapshot used to build the Skills URL and headers, preventing an intervening selection change from choosing another target's authentication. Explicit token connections retain the caller's headers.

[[src/renderer/src/screens/Layout/Layout.tsx#Layout]] mounts Skills separately for each connection and profile, discarding the previous target's list and selection before install or uninstall controls become usable.

Explicit token dashboards without a key retain anonymous, profile-scoped MCP access, as does auto mode after the management boundary identifies a keyless token dashboard. OAuth failures never fall back to anonymous requests.

## Test specifications

Focused tests protect credential isolation, automatic routing, ticket freshness, no-fallback behavior, and Settings presentation.

### Cookie session boundary

Session recognition accepts Hermes access or refresh cookie names in every deploy shape — bare, `__Host-` (direct HTTPS), `__Secure-` (path prefix), or `<tenant>_`-prefixed — and keeps cookie-backed requests inside the selected Electron partition.

### Session token compatibility

Session requests succeed against HTTP servers that accept only Bearer authentication or only the dedicated session header, preserving compatibility across gateway versions.

### Reverse proxy authentication

URLs containing proxy credentials retain Basic authorization while the dashboard receives its session token separately, preventing the compatibility header from breaking existing authenticated proxies.

### OAuth dashboard readiness

OAuth status requires a signed-in cookie session, authenticates REST without token headers, and probes WebSocket with a disposable ticket.

### Raw gateway classification

When `/api/status` is absent, a reachable or key-protected `/health` endpoint identifies token mode, while unrelated health failures remain user-visible connection errors.

### Atomic first-run connection

First-run Remote setup persists OAuth only after browser sign-in and token mode only after health validation; cancellation or failure preserves the prior connection configuration.

### Fresh ticket per connection

Every initial or reconnect attempt requests a new ticket URL, while token dashboards retain their stable token URL.

### OAuth no-fallback

Login-required Remote chat errors reach user-visible failure handling and never enter legacy `/v1` fallback.

### Settings authentication state

Settings probes auth automatically, shows browser sign-in for OAuth, preserves token input for token gateways, and handles cancellation without false connected state.

### Post-login config revalidation

OAuth login preserves settings changed while the browser is open and rejects completion when the selected gateway or connection mode changed.

### Loopback WebSocket confinement

Insecure remote WebSockets use a one-shot loopback relay with an unguessable path, while renderer CSP excludes the wildcard `ws:` source.

### OAuth bearer suppression

Once a Remote connection resolves to OAuth, shared request headers omit any stored token while token and SSH authentication remain unchanged.

### Management authentication routing

Management requests resolve `auto` before selecting token or OAuth transport, preserve profile scoping, skip probing for explicit modes, reject non-Remote callers, and retain OAuth login-required errors for reauthentication.

### Management failure classification

Token and OAuth HTTP failures expose the same structured status, with `404` identified as an unsupported feature instead of an application-wide connection failure.

### Auxiliary connection snapshot

Cookie-aware auxiliary requests use the caller's captured connection even after the active selection changes, keeping request authentication aligned with the original URL and profile.

### Anonymous MCP compatibility

Explicit token dashboards without configured keys can list MCP servers anonymously for a named profile, preserving open-gateway compatibility without weakening OAuth authentication.

### Reverse proxy discovery

Automatic detection forwards configured Basic proxy credentials to status and raw-health probes without putting userinfo in fetch URLs, while non-proxy raw gateways retain their Bearer header.

### Certificate defaults are preserved

Extending system trust retains bundled, extra, and existing custom roots, deduplicates overlaps, and leaves the original selection unchanged.

### Unsupported TLS runtimes keep defaults

A runtime missing either CA getter or setter keeps its existing trust rather than partially changing certificate validation.

### System trust lookup failures remain verified

A failed system-store read never invokes the setter or enables a permissive certificate or hostname fallback.

### Invalid system roots keep verification

A setter rejection is reported as unavailable without changing any request verification options.

### Real TLS requests honor selected system trust

An actual Electron run-as-Node child loads the real main entry before networking consumers, trusts a temporary system root for shared HTTPS and onboarding fetch, preserves extra CAs, and rejects unrelated roots and hostname mismatches.

The child substitutes only its system-store getter and isolates non-network UI startup. Real TLS, the production bootstrap, proxy/token headers, and captured profile routing execute against temporary loopback servers. Generated keys are deleted; no certificate bytes or OS/application trust settings are written. This fixture skips when the OpenSSL certificate-generation executable is absent; portable unit checks stay active. It validates runtime trust behavior, not a native Keychain or Linux/Windows store installation.
