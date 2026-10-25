# Operations map

| Task | Where | Notes |
| --- | --- | --- |
| Local database and environment setup | [README.md](../../README.md) → Manual development setup | Uses `backend/.env`; never commit it |
| Production bootstrap | [install.sh](../../install.sh) | Downloads a pinned source ref, validates OS, then runs the production setup |
| Runtime provisioning | [auto-setup.sh](../../auto-setup.sh) | Installs/validates Go, Node, PostgreSQL, builds artifacts, writes systemd/Nginx config |
| Database initialization | [setup.sh](../../setup.sh) | Creates PostgreSQL role/database and generates required secrets |
| Nginx/TLS deployment | [setup_nginx.md](../../setup_nginx.md) | API prefix, static frontend, firmware limits, CWMP proxy |
| Cloudflare deployment | [setup_cloudflare.md](../../setup_cloudflare.md) | Console Access is separate from CPE CWMP and firmware paths |
| Security baseline | [SECURITY.md](../../SECURITY.md) | Secrets, proxy CIDRs, TLS, backups, firmware controls |
| Container deployment | [docker-compose-coolify.yml](../../docker-compose-coolify.yml), [Dockerfile](../../Dockerfile) | Backend, web, PostgreSQL, firmware volume, health checks |
| CI checks | [.github/workflows/ci.yml](../../.github/workflows/ci.yml) | Backend, frontend, installer, and PostgreSQL 14–18 matrix |
| Health endpoint | `GET /api/health` through the proxy | Backend listens on API port 7548 by default |
| CWMP endpoint | `/` on port 7547 | Keep loopback/private and publish only through controlled TLS proxy |
| Firmware storage | `FIRMWARE_UPLOAD_DIR` | Treat files and signed query tokens as sensitive |

Required configuration names and their security meaning are documented in [README.md](../../README.md) and [SECURITY.md](../../SECURITY.md). Do not add real values here.
