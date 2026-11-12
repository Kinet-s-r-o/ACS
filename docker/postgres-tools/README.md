# PostgreSQL helper tools

This isolated Go module pins `gosu`, `timescaledb-tune`, and `timescaledb-parallel-copy` for the PostgreSQL image. The root Dockerfile rebuilds all three and replaces the binaries bundled by Timescale; updating Alpine packages cannot patch their embedded Go dependencies.

Update versions with `go get`, then `go mod tidy` in this directory. Keep the Go version aligned with the patched Docker builder. Preserve the tool directives so tidy retains these command dependencies.

Verify the `postgres` Docker target, `gosu postgres id`, both Timescale tools' version commands, initialization with `shared_preload_libraries=timescaledb,pg_stat_statements`, and the storage-probe health check against a disposable PostgreSQL instance. Scan the resulting image, including Go binaries. Never test using production volumes or credentials.

See [container security updates](../../SECURITY.md#container-security-updates) for rebuild and deployment guidance.
