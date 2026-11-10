# Product map

| Task | Where | Notes |
| --- | --- | --- |
| Operator session lifetimes | [Authentication guide](../authentication.md) → `auth/session_settings.go`, `api/session_settings.go`, `UserSessionSettingsMenu.tsx` | Users Read/Write, top-right Users menu, local/external durations applied at sign-in |
| Reboot after successful bootstrap | [Bootstrap reboot](../bootstrap-reboot.md) → `cwmp/bootstrap_reboot.go`, template General settings | Opt-in template policy, defaults off, waits for confirmed provisioning, existing template edit permission |
| Automatic CPE snapshots | [Snapshot automation](../automatic-snapshots.md) → CWMP `handler.go`, `snapshot_automation.go`, `TemplateSnapshotsForm.tsx` | Inform-triggered Initial/Scheduled checks, separate Manual snapshots, durable summon/refresh queue, existing Provisioning and CPE permissions |
| Template CPE edit forms | [Edit windows guide](../cpe-edit-windows.md) → `cpe_edit_window.go`, `CPEEditWindowDesigner.tsx`, `CustomCPEEditModal.tsx` | Writable reference metadata, interface-relative fields, typed selects, existing provisioning/CPE permissions |
| External billing/API integration | [Integration guide](../integration-api.md) → `backend/internal/api/integration.go`, `api_tokens.go`, `openapi.json`, `internal/auth/api_token.go` | User-linked tokens, serial-based CPE operations, Swagger contract and tests |
| Backend entrypoint and lifecycle | [backend/README.md](../../backend/README.md) → `backend/cmd/server/main.go` | Servers, migrations, recovery, retention, watchdog startup |
| CWMP/TR-069 protocol behavior | [backend/README.md](../../backend/README.md) → `backend/internal/cwmp/` | SOAP sessions, Inform, RPC handling, conditions, device watchdog |
| Global CWMP on/off | [backend/README.md](../../backend/README.md) → `backend/internal/cwmpcontrol/`, `internal/database/cwmp_control.go`, `internal/api/cwmp_control.go` | Durable gate, in-flight cancellation, session invalidation, worker/watchdog pause, `cwmp.control` permission |
| HTTP API and authorization | [backend/README.md](../../backend/README.md) → `backend/internal/api/` and `backend/internal/auth/` | Routes, permissions, security middleware, handlers |
| Operator authentication modules and RADIUS | [Authentication guide](../authentication.md) → [module router](../../backend/internal/authn/README.md), `internal/api/authentication.go`, console `AuthenticationSettings.tsx` → `RadiusAuthenticationSettings.tsx` | Method tiles and module details, local/RADIUS providers, ordered UDP/RadSec pools, encrypted secrets and focused permissions |
| Persistence and schema | [backend/README.md](../../backend/README.md) → `backend/internal/database/` and `models/` | GORM repositories, AutoMigrate models, encryption, Timescale setup |
| UI-managed DB indexes | [DB indexes guide](../database-indexes.md) → `managed_indexes.go`, `managed_index_definition.go`, `managed_index_worker.go`, `database_index.go`, `DatabaseIndexes.tsx` | Ownership, B-tree presets/custom builder, permissions, durable DDL jobs, disk probe and budgets |
| Console routes and screens | [frontend/README.md](../../frontend/README.md) → `frontend/src/pages/` | SolidJS routes are registered in `frontend/src/App.tsx` |
| Shared UI and interaction | [frontend/README.md](../../frontend/README.md) → `frontend/src/components/` | Layout, dialogs, charts, forms, feedback, pagination |
| API client and browser state | [frontend/README.md](../../frontend/README.md) → `frontend/src/lib/` | Typed API calls, auth/session, theme, storage, field definitions |
| Role permissions | [Permission expansion plan](../permission-expansion-plan.md) | Operator section catalog, per-section actions, inherited subtabs, conservative migration and API/UI enforcement |
| UI standards | [docs/ui-ux-standard.md](../ui-ux-standard.md) | Required for console changes |
| Installer checks | [scripts/README.md](../../scripts/README.md) | Shell validation and platform matrix |
