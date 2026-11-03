# Role permission expansion plan

## Current state

Custom roles store permission keys as JSON. The catalog in `backend/internal/models/role.go` has domain `read` and `write` keys plus focused grants. API routes enforce these keys; the role editor in `frontend/src/pages/RolesTab.tsx` exposes one checkbox per key. Unknown keys are rejected by the role API.

The main limitation is that `write` groups actions with different risk levels. For example, `devices.write` currently covers routine changes, device commands, credential changes, factory reset, snapshot restore, and deletion. A role cannot allow ordinary operation while withholding those higher-risk actions.

## Goal

Let administrators grant the smallest useful set of capabilities, with server-side enforcement as the source of truth. Keep existing role behavior during rollout and make each permission understandable in the editor.

## Proposed permission model

1. Keep the current domain `read`/`write` permissions as compatibility bundles.
2. Add focused permissions for high-risk or independently assignable actions first:
   - Devices: routine configuration/commands, sensitive credential management, destructive actions (factory reset and deletion), and snapshot restore.
   - Firmwares: upload/manage library and deliver firmware to devices as separate capabilities.
   - Users and roles: user administration/API token management and role definition management as separate capabilities.
   - Provisioning: rules and templates as independently assignable capabilities.
3. Map each existing route to the narrowest applicable permission. Existing `*.write` grants continue to satisfy the new checks during transition; new focused grants allow restricted roles to omit the broad grant.
4. Keep read access independent. Do not make write imply read unless the existing product behavior explicitly requires it.

Finalize exact permission keys and route mapping before implementation. Avoid creating a separate key for every endpoint; split only where tasks have meaningfully different risk or operator ownership.

## Implemented focused grants

`POST /devices` accepts `devices.create` or the legacy `devices.write` bundle. The Add CPE dialog uses the same grants. Creation reserves a unique, case-sensitive serial number and assigns existing catalog tags; changing tags later still requires `devices.configure` or `devices.write`.

Arming a factory reset for a pre-registered CPE also requires `devices.reset` (or `devices.write`) and fresh password/TOTP verification. The reset task is created atomically on the first Inform only while the device was Waiting; if the first CWMP session ends before dispatch, the task is failed and never retried on a later Inform.

The implementation adds these independently assignable grants: `devices.configure`, `devices.command`, `devices.reset`, `devices.delete`, `devices.credentials`, `devices.snapshots.write`, `devices.firmware`, `firmwares.manage`, `users.tokens`, `users.dashboards`, `provisioning.rules.write`, `provisioning.templates.write`, and `database.stats.read`. Existing domain `*.write` keys remain valid compatibility bundles and continue to authorize their former operations. The database statistics grant is excluded from the read-only system role because it exposes normalized SQL text; the built-in admin receives it with the other `AllPermissions`. `users.dashboards` lets an operator view and remove/reset saved Fleet panel configurations belonging to any user. The role editor lists the grants with descriptions.

## Implementation sequence

DB tools → DB indexes additionally defines `database.indexes.read` for catalog,
storage and job inspection, and `database.indexes.write` for mutations. Every
mutation requires both grants; `settings.write` is not a compatibility grant for
database DDL. Both are excluded from the read-only system role and granted to
the built-in admin. See [DB indexes](database-indexes.md) for the ownership policy.

1. **Inventory and map:** enumerate authenticated routes, UI actions, and existing permission gates; identify unguarded paths and routes with overly broad grants. Record the mapping in a permission catalog next to the backend model definitions.
2. **Backend catalog:** define stable keys and descriptions centrally; update `AllPermissions`, validation, and any system-role defaults. Add route middleware that accepts the focused key and its legacy bundle during transition.
3. **Compatibility:** preserve current effective permissions for saved roles. Add a migration or deterministic runtime expansion for legacy role grants, and document how roles behave after the transition. Do not silently downgrade access.
4. **Role editor:** render grouped permissions with concise descriptions and risk grouping. Support select/clear by group, show selected/available counts from the shared catalog, and explain broad compatibility permissions when present. Replace the hard-coded `18` count.
5. **Feature gates:** keep UI controls consistent with backend enforcement, but treat UI hiding as usability only; the API remains authoritative. Check token and session authentication paths use the same current role permissions.
6. **Audit and rollout:** review existing role assignments and identify roles whose broad grants can be narrowed. Release with compatibility enabled, then consider removing legacy bundle fallback only after explicit migration and operational review.

## Verification

- Unit tests cover permission catalog validity, legacy-to-focused compatibility, and denial when neither focused nor legacy permissions are present.
- API tests cover representative allowed and denied requests for each new permission, including API tokens and session authentication.
- Frontend checks confirm every permission is configurable, labels/descriptions are accessible, counts are catalog-driven, and controls follow the effective permission.
- Review all route registrations whenever a permission key is added or changed; run backend tests/vet and frontend UI check/build per the area routers.

## Ongoing requirement

Every new console section or feature must define its read and mutation permissions before implementation, enforce them on backend routes, and expose the relevant grants in role configuration. Update the permission catalog and this plan or its implementation documentation when the model changes.
