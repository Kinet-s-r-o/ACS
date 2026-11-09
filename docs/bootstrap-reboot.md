# Reboot after bootstrap

Provisioning → Edit/Add/Duplicate template → General → Bootstrap completion exposes **Reboot after successful bootstrap**. It defaults to false for new templates and existing rows. Saving an enabled policy does not contact or restart existing ONTs; it affects future `0 BOOTSTRAP` sessions matching the effective template. Ordinary `1 BOOT`, periodic Informs, and default-phase writes alone never arm the policy.

## Access and configuration

Existing template edit permission (`settings.provisioning.templates` Edit, resolved through the Provisioning Write section) controls this setting in the API and console. Both directions use the shared confirmation dialog; saving the template persists the draft. No new permission is introduced. Clone and JSON import/export preserve `reboot_after_bootstrap`; an omitted field in an update preserves the current value, and old backups without the field import with false.

The existing template AutoMigrate adds a non-null boolean column with `DEFAULT false`. This change adds no indexes. New requests accept an optional boolean; unrelated template/variable updates must not reset it.

## CWMP behavior

The handler tracks the bootstrap rules selected for this session and their confirmed applications. It waits for all provisioning SetParameterValues, AddObject, and conditional evaluation/write phases to finish, and requires at least one applicable bootstrap rule to have succeeded. Rules whose conditions are false do not require an operation. A condition that cannot be evaluated, variable expansion failure, failed rule load, provisioning SOAP fault, or invalid response inhibits reboot for that session. SetParameterValues status 0 and 1 are successful acknowledgements; status 1 permits reboot to apply deferred changes.

After successful completion the handler persists one ordinary `reboot` CWMP task with creator `bootstrap provisioning`. The normal task queue handles admission checks, CWMP pause, dispatch, and response/fault history. Repeated queue checks within the session cannot insert another reboot. A normal post-reboot BOOT session does not arm a new reboot. A subsequent genuine BOOTSTRAP, such as after factory reset, can run the policy again.

An interrupted or failed provisioning session does not create a reboot task. A reboot task already persisted after successful provisioning remains in the ordinary queue across ACS restart. A completed task indicates the ONT acknowledged the Reboot RPC; its next Inform is the evidence that it returned online.

Implementation: `backend/internal/cwmp/bootstrap_reboot.go`, `handler.go`, `session.go`; template model/repository and API create/update/clone/transfer handlers; console template form in `frontend/src/pages/Provisioning.tsx`.

Verification: `backend/internal/cwmp/bootstrap_reboot_test.go`, `backend/internal/api/bootstrap_reboot_test.go`, backend race tests/vet, and frontend UI check/build. Hardware-specific behavior still needs a controlled ONT trial before enabling the setting for other templates.
