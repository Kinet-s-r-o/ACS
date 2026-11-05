# Operator authentication

ACS supports named credential verification modules. Existing users migrate to
`local`; the optional `radius` module verifies credentials against an ordered pool
of up to eight servers. Account activation and roles are always managed in ACS.
Accounts must be created in ACS before users can sign in. The ACS username is sent
unchanged as RADIUS User-Name. Automatic provisioning and role-attribute mapping
are not supported.

## Configure RADIUS

Open **System settings → Authentication** and select the **RADIUS** tile to open
its detailed settings. Reading requires `auth.settings.read`.
Saving and testing require both `auth.settings.read` and `auth.settings.write`,
plus full access. The built-in admin role receives the new grants at startup.
The generic settings API cannot change or disclose authentication configuration.

1. Add servers in priority order and set the NAS identifier expected by policy.
2. Select each server's transport and explicit `host:port` address:
   - UDP normally uses port 1812 and requires a unique 16–253-byte shared secret.
     Use a protected network path; classic RADIUS does not encrypt the full packet.
   - TLS (RadSec) normally uses port 2083. TLS 1.2 or later is required. Certificate
     chain and server name are always verified. Blank CA configuration uses system
     trust; otherwise supply the trusted CA PEM. An optional server-name override
     supports connecting by IP to a certificate issued for a DNS name.
3. For mutual TLS, supply the client certificate chain and matching unencrypted
   PEM private key. RFC 6614 RadSec uses the fixed protocol secret `radsec`, rather
   than the UDP shared secret. RADIUS/1.1 and TLS-PSK are not implemented.
4. Set per-server timeout (1–10 seconds) and attempts (1–2), save and enable.
   Each credential check has a 15-second total budget; size the pool accordingly.
5. Use **Test saved RADIUS configuration**, then assign `radius` to a pilot account
   under **Users and Roles**. Tests never create an account or browser session.

Configure the RADIUS server to recognize the backend's actual source IP, including
any NAT, and permit the NAS identifier and PAP/Authenticate-Only requests. ACS
sends Message-Authenticator and requires a valid one in every reply, including
non-EAP Access-Accept, Access-Reject and Access-Challenge. Upgrade/configure servers
for BlastRADIUS protection; there is no option to disable integrity checks.

The complete RADIUS configuration is encrypted using ACS parameter encryption.
Shared secrets and client private keys are never returned by the API. Blank values
with their `*_set` flags preserve existing secrets by server ID, even after reorder.
To remove a stored client key, clear its retention checkbox and certificate chain.
Do not place secrets in frontend environment variables, exports, URLs or logs.

## Failure and recovery behavior

Network failures and timeouts allow retry/failover. An explicit rejection, invalid
reply, unsupported challenge or certificate validation failure ends the attempt.
There is no fallback to a local password for an externally authenticated account,
and no implicit TLS-to-UDP transport change. Mixed transports are possible only
when explicitly configured as separate pool entries.

At least one active local full-access administrator must remain. ACS blocks its
deactivation, demotion or conversion to an external module until another exists.
Changing a user's module clears local credentials when switching away from local
and increments the session token version. Switching back requires a new local
password. External passwords must be changed through the external service.

Sensitive operations use the assigned credential module for password step-up, or
the user's paired ACS TOTP authenticator. ACS TOTP enrollment and required second
factors also work after RADIUS acceptance. RADIUS Access-Challenge continuation,
EAP and MS-CHAP are outside this version; use ACS TOTP or a compatible password-only
RADIUS policy. Login audit events include `auth_provider` without credentials.

External browser sessions expire after one hour. Disabling a RADIUS identity or
the module does not revoke already-issued sessions; deactivate the ACS account
to block existing sessions immediately. User-linked API tokens remain independent
of RADIUS and must be revoked separately or blocked through ACS account activation.

## Verification

Run backend `go test -race ./...` and `go vet ./...`; PostgreSQL API tests use an
isolated schema when `TEST_DATABASE_URL` is configured. Frontend checks are
`npm run check:ui`, `npm test` and `npm run build`. RADIUS tests use synthetic
credentials and temporary loopback UDP/TLS servers; no production server is needed.

Protocol references: [RFC 2865](https://www.rfc-editor.org/rfc/rfc2865.html),
[RFC 6614](https://www.rfc-editor.org/rfc/rfc6614.html), and
[FreeRADIUS security guidance](https://www.freeradius.org/security/).
