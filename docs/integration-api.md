# External billing integration API

The ACS exposes a versioned integration API for identifying CPEs by serial number, reading stored parameters, requesting fresh values, writing parameters and tracking CWMP tasks. Each external system uses its own named, expiring API token attached to an existing operator account.

The complete machine-readable contract is [OpenAPI 3.0.3](../backend/internal/api/openapi.json). Interactive Swagger UI is available in **System settings → API documentation** (`/settings/api-docs`). The console can download the same document from `/api/openapi.json` using its session. It covers all integration and token-administration endpoints; internal console endpoints are not part of the external API contract.

## Enable an integration

1. Deploy backend and frontend together. Startup AutoMigrate creates `api_tokens`, adds task attribution/idempotency columns and audit token attribution. Back up the database before upgrading as usual; allow time for index creation on a large task history.
2. Create a named operator for the billing integration, or select an existing operator. Assign the required role. Use `devices.read` for stored values and task results, plus `devices.write` for fresh reads and writes. The integration has the same fleet scope as that operator; there is no per-customer/device isolation.
3. As a full-access administrator, open **Users and Roles**, click the key button beside that operator, enter the external system name and optional description, and choose an expiry of 1–365 days (default 90).
4. Copy the generated token into the billing system's secret manager. It is returned once and cannot be retrieved later. If the response is lost, inspect the token list, revoke the inaccessible token and generate another.
5. Configure the public API base, normally `https://acs.example.com/api`, and send `Authorization: Bearer <token>` on every `/v1` request. Verify access with `GET /v1/me`.

## Authentication and lifecycle

Tokens contain 256 random bits and use the `acs_` prefix. PostgreSQL stores only the SHA-256 digest and a non-secret identifying prefix. Requests never accept tokens in a query string or cookie. A web JWT cannot replace an API token, and an API token cannot log into the console or create other tokens.

The owning user and current role are checked for every request. Role changes affect the next request; a missing user, revoked token or expired token cannot authenticate. Role/database lookup failures deny access. An empty role grants no permissions. There are no separate token grants that could exceed the user's permissions. Existing in-flight operations can finish when permissions change or a token is revoked.

These are service credentials: interactive 2FA applies when the administrator signs into the console, not on each billing request. The owner need not complete an interactive login to use an administrator-issued service token. Password changes, logout and 2FA resets do **not** revoke service tokens. Revoke tokens explicitly when an integration is retired or compromised, and delete the owning account to block all its tokens.

Up to 100 unexpired, unrevoked tokens may exist per user. Rotate by generating a replacement, changing the billing secret, verifying `/v1/me`, then revoking the old token. Revocation does not cancel tasks already queued. Metadata lists include creation, expiry, last-used and revoked timestamps. Last-used is updated at most once per minute, not for every request.

Token administration requires a console session: full access plus `users.read` to list, or `users.write` to generate/revoke. Mutations retain normal CSRF cookie/header protection. The Swagger contract describes these endpoints, but the console token dialog is the intended administration interface.

## Transport and operational limits

Use the existing HTTPS reverse proxy. Do not expose API port 7548 directly. The configured `ADMIN_WEB_ALLOWED_CIDRS` also applies to billing clients, using the existing trusted-proxy rules. Include the billing source network in that policy when necessary. CORS remains restricted to configured/same origins; a server-to-server client normally sends no Origin header.

Each backend process allows 120 requests/minute/token and 600 requests/minute/source IP. HTTP 429 includes `Retry-After: 60`. Respect that delay, add jitter and bound retries. Requests have a 15-second server context deadline. JSON bodies are limited to 2 MiB; fresh-read/write batches to 100 paths; paths to 512 UTF-8 bytes; values to 4096 UTF-8 bytes. Unknown JSON fields and trailing JSON documents are rejected. Use string values even for boolean and numeric parameters.

Every authenticated integration request, including reads and permission denials, is audited with the current username, token ID, system name, method, path, source address and status. Authorization headers, request bodies and query values are not stored in the audit record. Apply the existing audit/task retention settings and keep external proxy/application logs free of bearer credentials. API responses use `Cache-Control: no-store`.

## Endpoint reference

All paths below are relative to the public API base (`/api` in a standard reverse-proxy deployment).

| Method | Path | Permission | Result |
| --- | --- | --- | --- |
| GET | `/v1/me` | Valid token | Current owner, system, token ID and permissions |
| GET | `/v1/devices` | `devices.read` | Paginated CPE identities, ordered by ID ascending |
| GET | `/v1/devices/{serial}` | `devices.read` | Latest stored identity and availability |
| GET | `/v1/devices/{serial}/parameters` | `devices.read` | Paginated stored parameters and timestamps |
| POST | `/v1/devices/{serial}/read` | `devices.write` | Queue GetParameterValues |
| POST | `/v1/devices/{serial}/write` | `devices.write` | Queue SetParameterValues |
| GET | `/v1/devices/{serial}/tasks` | `devices.read` | Paginated device task summaries, newest ID first |
| GET | `/v1/devices/{serial}/tasks/{taskID}` | `devices.read` | Task state, result and errors |
| GET | `/users/{id}/api-tokens` | Console administrator + `users.read` | Token metadata only |
| POST | `/users/{id}/api-tokens` | Console administrator + `users.write` + CSRF | One-time token secret |
| DELETE | `/users/{id}/api-tokens/{tokenID}` | Console administrator + `users.write` + CSRF | Revoke token belonging to that user |

Serial numbers are exact and case-sensitive. URL-encode them as individual path segments. Internal numeric device IDs are not required for CPE operations. Task IDs are checked against the supplied serial; a mismatch returns 404. Device identity responses omit connection-request credentials and full parameter trees.

### Pagination and parameter filtering

List responses use `{ "items": [...], "next_cursor": "..." }`. Supply `limit` (1–500, default 100) and then pass `next_cursor` unchanged as `cursor` until it is empty. Preserve all filters between pages. Device cursors are increasing IDs; task cursors are decreasing IDs; parameter cursors are names in database sort order. Queries use keyset pagination, without a fleet-wide load or total count. These are live listings, not a consistent snapshot; a concurrent update can change later pages.

Stored parameters support repeatable `name` filters for exact paths and a literal `prefix` filter. Repeated names use OR; prefix and names combine with AND. An unknown parameter is omitted (an empty list is valid); an unknown CPE returns 404. A parameter's `updated_at` indicates freshness. `writable` is omitted if unknown. `value_type` may also be unavailable before the device reports it.

Sensitive parameter values follow console visibility: full-access owners can read decrypted stored values; other users receive `[REDACTED]`. Sensitive values in task details are always redacted. Write acknowledgements omit payloads; task lists omit both payloads and results. Stored sensitive write values use the existing parameter encryption key. Use a dedicated role instead of an administrator token when the billing system does not need sensitive reads.

## Cached read example

The shell examples assume `ACS_BASE`, `CPE_SERIAL` and `BILLING_API_TOKEN` are supplied by the integration runtime. `CPE_SERIAL` below is already URL-encoded. Do not put real tokens in source code, command history, verbose HTTP traces or logs.

```bash
curl --fail-with-body --get "$ACS_BASE/v1/devices/$CPE_SERIAL/parameters" \
  --header "Authorization: Bearer $BILLING_API_TOKEN" \
  --data-urlencode 'name=InternetGatewayDevice.DeviceInfo.SoftwareVersion' \
  --data-urlencode 'limit=100'
```

```json
{
  "items": [{
    "id": 51,
    "device_id": 7,
    "name": "InternetGatewayDevice.DeviceInfo.SoftwareVersion",
    "value": "V1.2.3",
    "value_type": "string",
    "writable": false,
    "updated_at": "2026-10-26T10:00:00Z"
  }],
  "next_cursor": ""
}
```

## Fresh read and write

Cached reads do not contact the CPE. To obtain fresh values, queue a read and poll the returned task. Reads accept exact parameter paths or object paths ending in a dot, for example `InternetGatewayDevice.DeviceInfo.`. Wildcards such as `*` are not expanded.

```bash
curl --fail-with-body "$ACS_BASE/v1/devices/$CPE_SERIAL/read" \
  --header "Authorization: Bearer $BILLING_API_TOKEN" \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: billing-refresh-order-123' \
  --data '{"parameters":["InternetGatewayDevice.DeviceInfo.SoftwareVersion"]}'
```

Writes accept exact leaf paths and string values. They reject known read-only parameters. If writability or vendor support is unknown, the CPE supplies the final success/fault response.

```bash
curl --fail-with-body "$ACS_BASE/v1/devices/$CPE_SERIAL/write" \
  --header "Authorization: Bearer $BILLING_API_TOKEN" \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: billing-service-order-123' \
  --data '{"parameters":{"InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID":"Customer-WiFi"}}'
```

A new request returns **202 Accepted**, a task object containing `id`, `status: "pending"`, timestamps and attribution, and a relative `Location: tasks/{id}` header. Resolve Location against the POST request URL (not the host root) to preserve a proxy prefix such as `/api`.

The ACS executes the task during a CWMP session; these endpoints do not send a connection request or guarantee immediate execution. A disconnected CPE can stay pending. Periodic Inform and the existing task watchdog/retention settings control scheduling and history. `202` does not mean a configuration change has completed.

```bash
curl --fail-with-body "$ACS_BASE/v1/devices/$CPE_SERIAL/tasks/1234" \
  --header "Authorization: Bearer $BILLING_API_TOKEN"
```

Poll with a bounded interval/backoff, respecting the rate limit. `pending` and `sent` are nonterminal; `completed`, `failed` and `deleted` are terminal. Inspect `error_message` on failure. A successful read has a path/value object in `result`, and updates the stored parameter cache. SetParameterValues returns `result.status`: 0 means applied, 1 means accepted with application possibly deferred until reboot. Perform a subsequent fresh read to verify the final value when required by billing logic. Task detail can return 404 after retention deletes the record.

### Safe retries and idempotency

Use a unique `Idempotency-Key` for each logical read/write request, persisted alongside the billing operation ID. It accepts up to 128 ASCII letters, digits, `.`, `_`, `:` and `-`. It is scoped to the API token across devices and operations; do not place secrets in the key.

Identical retries, including simultaneous retries, return the original task with **200 OK**. JSON object key order does not affect write equality. A different path/value payload, device or operation under the same key returns **409 Conflict**. Keep the key and token unchanged when retrying a timeout. Without a key, every POST creates another task. A new token has a separate key namespace: reconcile outstanding operations before retrying after rotation.

Deduplication lasts while the task is retained. A key can create new work after its original task is deleted by retention/device removal; do not replay old billing operations outside that window. Existing authorization, device and input checks still apply to retries. To deliberately repeat a failed operation, use a new key only after checking the previous outcome.

## Errors

Application errors use `{ "error": "message" }`. Treat HTTP status as the stable signal; the text is for operators. The reverse proxy may return its own body on transport/body-limit failures.

| HTTP status | Meaning and client action |
| --- | --- |
| 400 | Invalid input, unknown fields, bad path, non-string value, invalid page or known read-only parameter; fix the request |
| 401 | Missing/invalid/expired/revoked token or deleted owner; replace the credential, do not blindly retry |
| 403 | Missing current permission or denied source network; review role/network policy |
| 404 | Unknown CPE/task, serial/task mismatch, expired history, or token not owned by the specified user |
| 409 | Conflicting idempotency key, or active token limit reached during generation |
| 413 | JSON exceeds 2 MiB; reduce the request |
| 429 | Rate limit; wait for Retry-After and use bounded retries |
| 500 | Persistence/processing failure; retry a task submission only with its original idempotency key |
| 503 | Authentication or role lookup unavailable; access fails closed, retry with backoff |

Unsupported routes/methods may use the HTTP router's standard 404/405 text response. No endpoint accepts arbitrary SQL or bypasses normal CPE write checks. Token permissions are fleet-wide; tenant-specific restrictions would require a separate authorization model.

## Validation and maintenance

`go test -race ./...` covers token authentication, permission changes, invalid payloads and route/document coverage. With `TEST_DATABASE_URL` set to a disposable PostgreSQL URL, `go test -race ./internal/api -run TestIntegrationAPIPostgres` additionally exercises the complete HTTP flow, isolated migrations, pagination, encrypted storage, revocation, user ownership, audit attribution and simultaneous idempotent writes. The test creates and drops its own uniquely named schema. CI includes the API tests in the PostgreSQL 14–18 matrix.

Swagger UI assets are bundled locally and loaded only on the documentation route. External validator requests and authorization persistence are disabled. Validate `openapi.json` with an OpenAPI 3.0 validator after contract changes and keep this guide synchronized. Breaking changes require a new API version; callers should tolerate additional response fields.
