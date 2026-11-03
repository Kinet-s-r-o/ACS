# Scripts area router

| File | What lives there | Read before changing |
| --- | --- | --- |
| `check-ui-standards.mjs` | Static checks for UI conventions | [UI standard](../docs/ui-ux-standard.md) |
| `test-install-platform.sh` | Shell-level installer platform validation | `install.sh` input validation |
| `postgres-index-storage-probe.sh` | PostgreSQL-host readiness and PGDATA/WAL free-space counters for UI index budgets | [DB indexes guide](../docs/database-indexes.md); no data-file reads or public probe-update API |

These scripts are invoked directly by CI and the root validation commands. Keep them portable for the Ubuntu runner and avoid reading secrets or `.env` files.
