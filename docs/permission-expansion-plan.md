# Operator permission catalog

Roles use `access.<section>.<action>` keys. The catalog is defined in `backend/internal/models/permissions.go`; authenticated `GET /permissions` returns section rows and each row's supported `actions`. The role editor displays only those supported choices. Other controls use internal screen aliases that resolve to these section grants.

| Section | Actions |
| --- | --- |
| Fleet status (`fleet`) | Full, Add, Read, Edit, Delete |
| CPE inventory (`inventory`) | Full, Add, Read, Write, Export |
| CPE overview (`cpe`) | Full, Read, Write, Delete, Export |
| CWMP tasks (`tasks`) | Full, Read, Delete, Export |
| CWMP faults (`faults`) | Full, Read, Write, Delete, Export |
| Firmware library (`firmwares`) | Full, Read, Write, Delete |
| Access controls / Device block list (`security.blocklist`) | Full, Read, Add, Remove |
| Access controls / Operator audit (`security.audit`) | Read |
| System settings / General (`settings.general`) | Full, Read, Write |
| System settings / System tasks (`settings.system_tasks`) | Full, Read, Write, Delete |
| System settings / DB tools (`settings.database`) | Full, Read, Write, Delete |
| System settings / Dictionaries (`settings.dictionaries`) | Full, Read, Write, Delete, Export |
| System settings / Users and Roles (`settings.users`) | Full, Read, Write, Delete, Import, Export |
| System settings / Authentication (`settings.authentication`) | Full, Read, Write |
| System settings / Delivery & connection (`settings.delivery`) | Full, Read, Write |
| System settings / Provisioning (`settings.provisioning`) | Full, Read, Write, Delete |
| System settings / API documentation (`settings.api_docs`) | Full, Read, Write |

Access controls and System settings are navigation groups without their own grants. A section's grants cover its existing and future subtabs. CPE overview is an independent section: CPE inventory Read covers CPEs, WANs and future inventory tabs, but does not grant device-detail access. Metric definitions uses Provisioning grants.

Full grants every operation in its section, including existing transfer operations that have no standalone catalog action. It does not grant sibling sections. Other actions require Read; selecting an action in the role editor automatically selects Read. Read does not imply Add, Write, Edit, Delete, Remove, Import or Export.

## Operations

- Fleet Add creates panels; Edit changes panel configuration and saved layout; Delete removes panels. The shared panel-save endpoint compares the new list with the locked persisted snapshot so an addition cannot smuggle an edit or deletion. Read does not save layout or expose editing controls. Administrative edits to another user's dashboard remain under Users and Roles Write.
- Inventory Add creates a waiting CPE. Inventory Write queues Summon visible and Restart visible. CPE overview Write changes parameters/tags and queues Summon, Reboot, Factory reset and network-object changes. Delete on CPE overview removes the CPE record, not task/fault history. Existing fresh password/TOTP verification remains mandatory for reset/restart operations.
- CWMP task deletion and fault resolving/deletion retain their own Tasks/Faults permissions, including actions entered from device detail. Snapshot deletion requires CPE Full. Read-only parameter and credential responses stay redacted; inventory Full does not reveal independent CPE secrets.
- Firmware Write includes upload. Device block list Add blocks a serial, Remove unblocks it. Operator audit has Read only.
- Users and Roles shares one set of grants across both tabs, including independent Import and Export. Write includes creating/updating accounts and roles. Delete removes accounts or custom roles; self-deletion, last-administrator protection and delegation limits remain enforced. Deleting an account removes its tokens and saved dashboard, retaining audit records.
- Provisioning Write covers all configuration subtabs, Metric/Health and future Advanced settings tabs. Delete controls configuration removal. Existing provisioning JSON import/export require Full. API documentation Read shows the specification; Write enables Swagger command testing, which still requires a token authorized for the target API operation.

## Migration and system accounts

`database.MigrateOperatorPermissionCatalog` performs a one-time, transaction-protected migration recorded in the existing settings table. A consolidated grant is retained only when the old grants covered all former boundaries for that operation. Partial granular grants are not promoted into broader section permissions. Review existing custom roles after upgrading; incompatible partial grants can be removed. Re-running startup preserves roles already configured with the new catalog.

Built-in admin/viewer defaults are synchronized at startup. The system administrator always resolves the entire current catalog; viewer receives the supported Read grants. Sessions and API tokens resolve current role permissions on every request and fail closed on lookup errors. No schema changes or new indexes are needed.

## Verification

Tests cover the exact catalog, future-subtab inheritance, inventory/detail separation, independent actions, route and payload authorization, secret redaction, privilege delegation and conservative migration. PostgreSQL fixtures cover migration idempotency, Fleet mutations, account deletion and JSON transfers without creating application indexes. Run backend race/vet and frontend UI/test/build checks from their area roots.
