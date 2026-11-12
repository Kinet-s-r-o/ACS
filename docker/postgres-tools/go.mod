module github.com/matrix8412/acs/docker/postgres-tools

go 1.27.4

tool (
	github.com/tianon/gosu
	github.com/timescale/timescaledb-parallel-copy/cmd/timescaledb-parallel-copy
	github.com/timescale/timescaledb-tune/cmd/timescaledb-tune
)

require (
	github.com/fatih/color v1.19.0 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/pgx/v5 v5.13.0 // indirect
	github.com/jackc/puddle/v2 v2.2.3 // indirect
	github.com/jmoiron/sqlx v1.4.0 // indirect
	github.com/mattn/go-colorable v0.1.16 // indirect
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/moby/sys/user v0.5.0 // indirect
	github.com/pbnjay/memory v0.0.0-20210728143218-7b4eea64cf58 // indirect
	github.com/tianon/gosu v0.0.0-20261025094355-29b939aa5bd4 // indirect
	github.com/timescale/timescaledb-parallel-copy v0.13.2 // indirect
	github.com/timescale/timescaledb-tune v0.19.1 // indirect
	golang.org/x/crypto v0.59.0 // indirect
	golang.org/x/sync v0.25.0 // indirect
	golang.org/x/sys v0.50.0 // indirect
	golang.org/x/text v0.44.0 // indirect
)
