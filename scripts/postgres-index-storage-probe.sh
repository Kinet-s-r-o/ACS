#!/bin/sh
# Run on the PostgreSQL host. Only filesystem counters are collected; no database
# files or parameter values are read. No credentials are printed or persisted.
set -eu
export PGUSER="${PGUSER:-${POSTGRES_USER:-acs}}"
export PGDATABASE="${PGDATABASE:-${POSTGRES_DB:-acs}}"
export PGCONNECT_TIMEOUT=2
pg_isready -q || exit 1
# Schema migrations may not have run yet. An unavailable probe must not prevent
# PostgreSQL from becoming healthy and allowing the backend to run migrations.
present=$(psql -X -At -v ON_ERROR_STOP=1 -c "SELECT to_regclass('public.database_index_storage_probes') IS NOT NULL") || exit 0
[ "$present" = t ] || exit 0
data_dir=$(psql -X -At -v ON_ERROR_STOP=1 -c 'SHOW data_directory') || exit 0
# WAL can be on another mount. Use the smallest available space and the largest
# filesystem capacity so the backend's reserve is conservative for both mounts.
counts=$(df -Pk "$data_dir/base" "$data_dir/pg_wal" | awk 'NR>1 { if (!seen || $4 < free) free=$4; if ($2 > total) total=$2; seen=1 } END { if (seen) printf "%.0f %.0f", total*1024, free*1024 }')
case "$counts" in ''|*[!0-9\ ]*) exit 0 ;; esac
total=${counts%% *}
free=${counts##* }
[ "$total" -gt 0 ] || exit 0
psql -X -q -v ON_ERROR_STOP=1 -v total="$total" -v free="$free" <<'SQL' || exit 0
SET statement_timeout='2s';
INSERT INTO public.database_index_storage_probes (id,total_bytes,free_bytes,measured_at)
VALUES (1, :'total'::bigint, :'free'::bigint, clock_timestamp())
ON CONFLICT (id) DO UPDATE SET total_bytes=EXCLUDED.total_bytes,
 free_bytes=EXCLUDED.free_bytes, measured_at=EXCLUDED.measured_at;
SQL
