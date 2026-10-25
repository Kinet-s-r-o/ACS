# Product map

| Task | Where | Notes |
| --- | --- | --- |
| Backend entrypoint and lifecycle | [backend/README.md](../../backend/README.md) → `backend/cmd/server/main.go` | Servers, migrations, recovery, retention, watchdog startup |
| CWMP/TR-069 protocol behavior | [backend/README.md](../../backend/README.md) → `backend/internal/cwmp/` | SOAP sessions, Inform, RPC handling, conditions, device watchdog |
| HTTP API and authorization | [backend/README.md](../../backend/README.md) → `backend/internal/api/` and `backend/internal/auth/` | Routes, permissions, security middleware, handlers |
| Persistence and schema | [backend/README.md](../../backend/README.md) → `backend/internal/database/` and `models/` | GORM repositories, AutoMigrate models, encryption, Timescale setup |
| Console routes and screens | [frontend/README.md](../../frontend/README.md) → `frontend/src/pages/` | SolidJS routes are registered in `frontend/src/App.tsx` |
| Shared UI and interaction | [frontend/README.md](../../frontend/README.md) → `frontend/src/components/` | Layout, dialogs, charts, forms, feedback, pagination |
| API client and browser state | [frontend/README.md](../../frontend/README.md) → `frontend/src/lib/` | Typed API calls, auth/session, theme, storage, field definitions |
| UI standards | [docs/ui-ux-standard.md](../ui-ux-standard.md) | Required for console changes |
| Installer checks | [scripts/README.md](../../scripts/README.md) | Shell validation and platform matrix |
