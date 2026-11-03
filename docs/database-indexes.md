# DB indexes

System settings → DB tools → **DB indexes** manages optional, application-owned
PostgreSQL indexes. It never adopts existing indexes. Removing a managed index
executes `DROP INDEX CONCURRENTLY`; its UI definition disappears only after the
database object has been removed. Parameter data is preserved.

## Permissions

| Permission | Capability |
| --- | --- |
| `database.indexes.read` | View the managed register, index catalog, sizes, scans, jobs and disk budget |
| `database.indexes.write` plus `database.indexes.read` | Preview, create, replace, cancel and delete UI indexes |

The built-in admin receives both grants. Neither the read-only system role nor
legacy `settings.write` gains index mutation access. Custom roles can assign the
two grants in Users and Roles. Mutations use session authentication, existing
CSRF protection and the existing audit log.

## Approved definitions

Users supply a label, a query/purpose, one exact non-sensitive parameter leaf
path, and an approved recipe. The server generates the PostgreSQL name.

| Recipe | Fixed B-tree keys | Partial predicate |
| --- | --- | --- |
| Parameter presence by CPE | `device_id` | `name = '<exact path>'` |
| Parameter freshness | `updated_at DESC, device_id` | `name = '<exact path>'` |

These definitions index at most one current row per CPE/path, using the existing
unique `(device_id, name)` constraint. Parameter values are never indexed or
included, so a long value received in Inform/GPV cannot violate a B-tree key-size
limit. GIN and every other method, free SQL, arbitrary tables/columns/expressions,
INCLUDE, uniqueness, wildcard paths, branches, sensitive paths and device logs
are rejected by the backend, including forged API requests.

The planner must be able to prove the exact path predicate to use a partial
index. A generic wildcard query does not automatically benefit from an exact
path index. UI definitions do not rewrite existing application SQL, and creating
an index does not guarantee PostgreSQL will choose it. The preview uses
`EXPLAIN (FORMAT JSON)` without executing the parameter query and a conservative
row/size estimate. It never returns parameter values.

## Resource policy

Limits are fixed in the backend and cannot be raised through the UI:

- At most 8 definitions, 256 MiB per physical UI index, 1 GiB total UI indexes.
- A disk reserve of the greater of 10 GiB or 20% of the monitored filesystem
  capacity. Construction additionally reserves space for the index, sorting and
  WAL. Queued/replacement indexes reserve their full size allowance.
- A PostgreSQL-host filesystem measurement no more than 35 seconds old is
  mandatory before construction and throughout each build. Missing or stale
  readings block new builds and cancel a running build.
- One managed DDL operation per database, serialized by a PostgreSQL session
  advisory lock. Concurrent creation/removal allows ordinary CPE reads/writes.
  The lock, DDL and cleanup use at most three short-lived dedicated connections,
  keeping the application's pool available even with a one-connection pool.
- 15-minute statement timeout, 3-second lock timeout, 32 MiB maintenance memory,
  256 MiB temporary-file limit and no parallel maintenance workers.
- Every two seconds, construction checks cancellation, actual index sizes and
  disk availability. The idle watchdog removes oversized UI indexes or removes
  UI indexes to restore the total budget/disk reserve. Non-UI indexes are never
  removed. An evicted definition remains visible with its reason and can be
  edited/retried or deleted.

These are monitored budgets, **not hard filesystem quotas**. Sampling, filesystem
reporting, concurrent writes, temporary files and WAL can overshoot a threshold.
Other applications, databases and pre-existing indexes can still exhaust storage.
For an absolute host storage boundary, enforce filesystem/storage quotas and
monitor PostgreSQL/WAL independently. The disk probe covers the `pg_default` and
WAL mounts; databases whose default tablespace is elsewhere are rejected.

## PostgreSQL storage probe

Both Compose deployments build the existing TimescaleDB PG17 image with the
small `postgres` Dockerfile target. Its health check runs
`scripts/postgres-index-storage-probe.sh` every 10 seconds. The database volume,
PostgreSQL version and private network remain the same. The script obtains the
data directory from PostgreSQL and measures available filesystem blocks for
`base` and `pg_wal`; it stores only counters and a database timestamp in the
singleton `database_index_storage_probes` table.

The probe does not read PostgreSQL data files and the backend does not mount the
database volume. Before the new migration exists, the probe still reports normal
PostgreSQL readiness, so backend migrations can run without a dependency cycle.
Probe failures leave the old measurement to expire rather than claiming fresh
free space. Deletion and recovery do not require a fresh disk measurement.

For a non-Compose PostgreSQL installation, run the script on the database host
every 10 seconds using an existing protected connection configured with normal
libpq settings. Use a service timer/loop; once per minute is too slow. The probe
connection needs permission to inspect `data_directory` and insert/update this
table. No public HTTP probe-update endpoint exists. The deployment uses the
standard `public` application schema; isolated test schemas inject their own
probe records.

A non-superuser ACS database role needs a DBA-configured temporary-file cap:
`ALTER ROLE <acs-role> SET temp_file_limit = '256MB';` (then reconnect the pool),
or permission to set this parameter where supported. Preview fails closed when
the mandatory cap cannot be applied. UI index management never grants database
privileges or creates a SECURITY DEFINER shell-execution function.

## Ownership and recovery

`managed_database_indexes` persists desired definitions, generated names, object
OIDs, catalog definitions, random ownership markers and operation state. The
worker verifies the registry, OID, complete catalog definition and ownership
comment before changing an active object. Primary/unique/constraint indexes,
non-B-tree indexes and altered/unverified objects are protected. Matching a name
prefix alone never permits deletion.

Replacement creates and verifies a new random object before dropping the old
one. Cancellation or failed construction cleans up the candidate and preserves
the old index. On restart, an interrupted candidate is matched against its
pre-registered random name and exact approved definition, then removed. A failed
cleanup remains registered for retry; it is never forgotten as an orphan.

An index altered outside ACS, or restored with different object identifiers,
fails ownership verification. Review it with the DBA rather than importing it
into UI ownership. UI polling stops when the document is hidden; forms retain
entered values after errors and rows retain DOM identity across polling.

## API and code

The authenticated `/settings/database/indexes` collection provides GET, POST;
`/{id}` provides PUT and DELETE; `/preview` and `/{id}/preview` provide POST
preflight; `/{id}/cancel` provides POST cancellation. Mutations return 202 for a
durable queued operation. Unknown JSON fields and multiple JSON bodies are
rejected. IDs refer to registry records, never arbitrary catalog OIDs.

Models live in `backend/internal/models/database_index.go`; policy, catalog and
preflight in `backend/internal/database/managed_indexes.go`; DDL/recovery/watchdog
in `managed_index_worker.go`; routes in `backend/internal/api/database_indexes.go`;
console in `frontend/src/pages/DatabaseIndexes.tsx`.

`TestManagedIndex*` and `TestDatabaseIndex*` cover policy, schema migration,
real concurrent creation/replacement/drop, cancellation/recovery, ownership,
disk pressure, preserved parameter writes and route authorization. Set
`TEST_DATABASE_URL` to an isolated PostgreSQL 14–18 test database to run the
PostgreSQL cases. Never point these tests at a production database.
