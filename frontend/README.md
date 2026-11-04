# Frontend area router

| Folder or file | What lives there | Read before changing |
| --- | --- | --- |
| `src/App.tsx` | SolidJS router, auth boundary, lazy page registration | Target page and `lib/auth.tsx` |
| `src/pages/` | Route-level screens for dashboard, devices, faults, firmware, settings, security, and provisioning | `src/lib/api.ts` and UI standard |
| `src/components/` | Shared layout, dialogs, charts, state, pagination, and device-setting modals | Existing component contract and caller pages |
| `src/lib/api.ts` | Typed API client and domain response shapes | Matching backend route/handler |
| `src/lib/` | Auth/session, theme, storage, filters, metrics, WAN/LAN/Wi-Fi field definitions | Relevant page/component tests |
| `tests/` | Node tests for field definitions, filters, health, metrics, pagination, and visibility | Run `npm test` |
| `package.json` | Node engine, scripts, Solid/Vite/Tailwind dependencies | CI frontend job |
| `index.html`, `vite.config.ts`, `tsconfig*.json` | Build and TypeScript/Vite configuration | `npm run build` |

Use semantic tokens and existing components. Run `npm run check:ui` and `npm run build` after console changes; do not put secrets in frontend environment files or bundles.

Provisioning CPE info fields support an optional `postfix` (up to 32 characters). Preserve whitespace so operators can enter units such as ` dBm`; append it as plain text after the formatted ONT Information value, excluding missing/empty placeholders. The existing `provisioning.templates.write` or `provisioning.write` route grants control edits. It travels with the existing JSON template fields through clone/import/export and needs no schema migration. Keep the editor on `<Index>` so typing a postfix preserves focus.

System settings → General → UI settings persists `ui_datetime_format` through the existing `settings.write` route (`settings.read` to view settings). The safe public `/meta` response loads it for all users via `appName.ts`; saving applies it immediately. Use `lib/dateTime.ts` for displayed timestamps, chart time axes/tooltips, and typed `dateTime` parameter values. Keep numeric `unsignedInt` values, durations and edit payloads raw: Unix timestamps require explicit unit metadata rather than guessing. Device All parameters and Connected hosts expose hideable/filterable Last updated columns using existing `devices.read` access. Host freshness (`lib/parameterFreshness.ts`) is the newest valid `updated_at` among the host/merged Wi-Fi association parameters; it is a record refresh, not a value-change timestamp. Preserve stable table keys and cell IDs when extending those columns.

Every shared Dialog has a bottom-right resize handle: pointer drag, arrow keys (Shift for larger steps), Home to reset, or click for width/height sliders. Dimensions are local to the open dialog, clamped to viewport bounds on resize, and reset when a side panel opens/closes. Keep form identities and nested-dialog focus behavior intact. This presentation control uses the caller's existing permissions and introduces no API grant.

Drag anywhere on the shared Dialog title bar to move it; interactive header controls retain their own actions. The focusable title bar also supports arrow keys (Shift for larger steps) and Home to restore default size/position. Resize controls include horizontal/vertical position sliders as a pointer alternative. Movement preserves current dimensions and stays within viewport margins, including after orientation changes; pointer capture is released on completion, cancellation and unmount.

Provisioning's Condition question mark opens `components/ProvisioningConditionHelp.tsx`. At widths of 1024px and above, it expands the rule Dialog with a right-hand reference panel; the form and help scroll independently within one focus trap. Smaller screens retain the nested help modal. Keep the form mounted when toggling help or crossing the breakpoint so unsaved text and focus survive. Keep examples and limitations aligned with `backend/internal/cwmp/condition.go` and the live existence probes in `handler.go`.

Fleet status defaults to Device growth only. Additional panels must be user-created (`custom-*` IDs); parameter thresholds and category aggregations use `devices.read`. Do not restore retired built-in panels or import old browser panel configurations.

DB tools is `pages/RetentionSettings.tsx`; its DB indexes tab is `pages/DatabaseIndexes.tsx`. The [DB indexes guide](../docs/database-indexes.md) defines permitted recipes, API, ownership and budgets. Gate the tab by `database.indexes.read` and mutations by both index grants; existing `settings.write` does not grant DDL access. Keep form/row identities stable while background status polling replaces response objects.

CPE pre-registration uses `components/CreateDeviceDialog.tsx` and `POST /devices`. `lib/deviceStatus.ts` and `components/DeviceStatusBadge.tsx` display Waiting for CPEs with no first Inform and no online state. Keep inventory filters, exports, detail badges, and fleet counts consistent with this lifecycle.
