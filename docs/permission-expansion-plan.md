# Section and tab permissions

## Model

Saved roles use `access.<section>.<action>` keys. The only actions are **Full, Read, Edit, Delete, Import, Export**. Each menu entry, submenu and nested tab has its own row. This includes Requested/Result task tabs, Metric/Health, Wi-Fi/LAN/WAN dialogs and user-defined Advanced settings tabs.

Full grants all actions on its own row only. It never grants a child or sibling row. Other actions require Read on the same row; the role editor selects Read automatically. A parent can be traversed when a descendant is readable, without granting operations on the parent. Shared reference endpoints explicitly name their consumers.

Edit covers create/update and operational commands; Delete covers removals; Import/Export cover transfers where supported. Factory reset requires Full on `inventory.cpes.maintenance.diagnostic` and the existing fresh verification. Full provisioning backup/clone requires the relevant action on every included section and dynamic tab. Replacing configuration during import also requires Delete on replaced sections.

## Catalog and enforcement

- Static catalog: `backend/internal/models/permissions.go`.
- Dynamic catalog: `backend/internal/database/permission_catalog.go`; Advanced settings feature IDs create separate rows under `settings.provisioning.features` and `inventory.cpes.features`.
- Console discovery: authenticated `GET /permissions` returns actions and ordered section rows; `RolesTab.tsx` renders the six-column matrix.
- API policies: `backend/internal/api/permission_policy.go`; every authenticated console/integration route must have an explicit policy. Shared payload handlers additionally validate fields against their own tab. Metric/Health updates preserve inaccessible fields; filtered Advanced settings saves preserve unsubmitted tabs and use explicit `deleted_ids` for tab deletion.
- Network parameter policies: `permission_network_fields.go` mirrors editable suffixes in `frontend/src/lib/{wifi,lan,wan}Fields.ts`. New fields require a matching tab policy. Diagnostic access remains a separate explicit raw-parameter workflow.
- Console visibility: `frontend/src/lib/permissions.ts`, `SectionPage.tsx`, menu filtering and page/tab checks. UI visibility is not an authorization boundary.

Legacy constants and component adapters remain internal implementation details. Legacy keys are neither accepted in saved role updates nor advertised as permission types. The authoritative section middleware runs before internal legacy wrappers.

## System accounts and rollout

The built-in system `admin` always resolves the entire current catalog, including dynamic rows, regardless of its persisted permission snapshot. Only this role maps to the administrative account role. Sessions and API tokens resolve current permissions on each request and fail closed on lookup errors.

At startup, built-in admin/viewer defaults are synchronized. Obsolete keys are removed from custom roles without migration into broader grants. **Existing custom roles must be configured again after upgrading.** No new database columns or indexes are required. Viewer defaults exclude credential access, SQL statistics and index administration; dynamic tabs require explicit grants.

## Verification and future changes

Tests cover own-row Full, navigation without inheritance, action independence, field isolation, explicit dynamic-tab deletion, privilege delegation limits, default admin access and current permissions for API tokens. PostgreSQL tests use `TEST_DATABASE_URL` and isolated schemas. Run the backend race/vet checks and frontend UI/test/build commands from the area routers.

For each new section/tab, add its catalog row, backend route/payload policy and frontend visibility in the same change. Never introduce another action type or authorize a child through its parent.
