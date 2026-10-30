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

Fleet parameter search uses the `pg_trgm` extension and the GIN index `idx_device_parameters_name_trgm` for wildcard parameter paths. After the API starts and any WAN inventory preparation finishes, the backend installs the extension if needed and builds the index concurrently. The database must provide `pg_trgm`; the application role needs permission to install it (database `CREATE`) or an administrator must install it first. Wait for `Fleet parameter search index is ready (idx_device_parameters_name_trgm)` before measuring dashboard performance after the first deployment. Index construction uses additional disk space and I/O; it does not block API startup. Interrupted builds are repaired on the next startup, while valid indexes are reused. Creation failures are logged and leave the existing queries available without the search index.

External integration contract: [API guide](../docs/integration-api.md) and `internal/api/openapi.json`. Keep the embedded OpenAPI document synchronized with `integration.go` and `api_tokens.go`. The token middleware in `internal/auth/api_token.go` must resolve current permissions without a permissive fallback on lookup failure. `integration_postgres_test.go` runs in an isolated schema when `TEST_DATABASE_URL` is set.
