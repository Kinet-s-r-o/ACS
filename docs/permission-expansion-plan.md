# Role permission expansion plan

## Current state

Custom roles store permission keys as JSON. The catalog in `backend/internal/models/role.go` has 18 keys: `read` and `write` for users, roles, devices, firmwares, faults, provisioning, settings, metrics, and security. API routes enforce these keys; the role editor in `frontend/src/pages/RolesTab.tsx` exposes one checkbox per key. Unknown keys are rejected by the role API.

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

The first implementation adds these independently assignable grants: `devices.configure`, `devices.command`, `devices.reset`, `devices.delete`, `devices.credentials`, `devices.snapshots.write`, `devices.firmware`, `firmwares.manage`, `users.tokens`, `provisioning.rules.write`, and `provisioning.templates.write`. Existing domain `*.write` keys remain valid compatibility bundles and continue to authorize their former operations. The role editor lists both legacy bundles and focused grants with descriptions.

## Implementation sequence

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
