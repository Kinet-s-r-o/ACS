# Backend area router

| Folder or file | What lives there | Read before changing |
| --- | --- | --- |
| `cmd/server/main.go` | Configuration, database connection, migrations, two HTTP servers, maintenance loops | [Root README](../README.md) deployment and security sections |
| `internal/api/` | Authenticated REST handlers and route registration | `router.go`, relevant handler, API client contract |
| `internal/auth/` | JWT, password policy, permission middleware | `SECURITY.md` |
| `internal/cwmp/` | CWMP/SOAP sessions, Inform/RPC handling, conditions, watchdog | CWMP settings and protocol tests |
| `internal/database/` | Repositories, encryption, settings, task/fault/metric persistence | Models and migration code in `cmd/server/main.go` |
| `internal/models/` | GORM entities and status/permission types | Repository using the model and AutoMigrate list |
| `go.mod` | Go version and dependency source of truth | CI backend job |
| `*_test.go` | Unit and integration coverage by package | Run `go test -race ./...` |

Keep sensitive values out of logs and tests. Database schema changes must remain compatible with the supported PostgreSQL 14–18 matrix.

`internal/database/compression.go` reconciles metric compression policies independently of retention every minute. Settings use `settings.read` / `settings.write`; `/settings/retention/compression` reports actual policies and compressed chunk counts. Disabling removes automatic policies without decompressing history. Raw samples retain the legacy two-hour default; aggregate minimum ages (8/31/366 days) protect their refresh windows. Operational tables retain PostgreSQL's native large-value compression and existing search behavior, without an age-based compression policy. `TestCompressionPoliciesTimescale` uses an isolated schema when `TEST_DATABASE_URL` points to TimescaleDB.

Device parameter storage keeps device-scoped indexes for CPE reads and writes, plus a small partial index for RX-power inventory lookups. The backend does not build the global Fleet wildcard GIN index or the large Fleet latest-value covering index. Fleet analytics endpoints remain available and use device-scoped lookups, but large Fleet dashboards are not optimized for installations that remove those panels.

Optional [UI-managed DB indexes](../docs/database-indexes.md) use `internal/database/managed_indexes.go` for the fixed B-tree policy/catalog/preflight and `managed_index_worker.go` for serialized concurrent DDL, cancellation, restart recovery and ongoing storage enforcement. `internal/models/database_index.go` holds the ownership registry and PostgreSQL-host disk probe snapshot. Never infer ownership from a name prefix or extend the allowlist to GIN/arbitrary SQL. Read requires `database.indexes.read`; every mutation requires it plus `database.indexes.write`.

External integration contract: [API guide](../docs/integration-api.md) and `internal/api/openapi.json`. Keep the embedded OpenAPI document synchronized with `integration.go` and `api_tokens.go`. The token middleware in `internal/auth/api_token.go` must resolve current permissions without a permissive fallback on lookup failure. `integration_postgres_test.go` runs in an isolated schema when `TEST_DATABASE_URL` is set.
