# Credential verification modules

`Provider` verifies an `Identity` and password using a context. Register a named
provider once in `api.NewRouter`; `local` is built into `Registry`. Authorization,
account activation, TOTP, audit and session issuance remain ACS responsibilities.
Unknown modules and configuration failures fail closed. Never chain providers as
fallbacks for the same user. Login and password step-up use the same registry.

`Radius` loads encrypted configuration through an injected callback. Its ordered
server pool retries only transport errors, within a 15-second overall budget.
Rejects, challenges, malformed replies and certificate validation failures are
terminal. Both UDP and TLS require response authenticators and exactly one valid
Message-Authenticator. TLS uses normal certificate/name verification, optional
mutual TLS, stream framing and the RFC 6614 `radsec` secret. UDP uses a per-server
shared secret. PAP is the only credential method; EAP, MS-CHAP and RADIUS challenge
continuations are not implemented. ACS TOTP remains supported.

Read [operator guidance](../../../docs/authentication.md) before changing the
configuration contract. `radius_test.go` exercises real loopback UDP/TLS servers,
including client certificates, fragmented TLS records, failover and forged replies.
Never add credential or packet contents to errors or logs.
