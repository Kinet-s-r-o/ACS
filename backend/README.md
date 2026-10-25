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
