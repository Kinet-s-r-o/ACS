# ACS Agent Guide

ACS is a beta TR-069/CWMP control plane: Go backend, SolidJS/TypeScript console, PostgreSQL, and Nginx/Docker deployment.

## Read first

- Pick the task router in [docs/map/](docs/map/).
- Follow the area router before changing code: [backend/README.md](backend/README.md), [frontend/README.md](frontend/README.md), or [scripts/README.md](scripts/README.md).
- Keep [README.md](README.md) as the product and operator overview; keep deployment/security details in the existing linked guides.

## Hard rules

- Never read, copy, log, or commit `.env` files, credentials, firmware, tokens, or customer/device exports.
- Preserve security boundaries: TLS at the proxy, explicit CORS and proxy CIDRs, protected CWMP, encrypted sensitive parameters, and signed firmware URLs.
- For every new console section or feature, define its required permissions before implementation; enforce them in backend routes and reflect them in UI visibility and role configuration.
- Do not expose API/CWMP/PostgreSQL ports directly in production.
- Preserve existing working-tree changes. Do not commit, push, deploy, or change application behavior unless requested.
- UI changes must follow [docs/ui-ux-standard.md](docs/ui-ux-standard.md) and pass the UI check.
- Tables using `enableTableColumnReordering` must give every reorderable data cell a stable `data-column-order-id` matching its header ID; never rely on the cell's current DOM index after reordering. When adding columns, keep the table order key stable or migrate saved order, and add the new column to the default order where applicable.

## Verification

- Backend: `cd backend; go test -race ./...; go vet ./...`
- Frontend: `cd frontend; npm ci --include=dev; npm run check:ui; npm run build`
- Installer: `bash -n install.sh setup.sh auto-setup.sh scripts/test-install-platform.sh; bash scripts/test-install-platform.sh`
- CI also runs Staticcheck, govulncheck, gosec, npm audit, and PostgreSQL 14–18 compatibility tests.

## Map upkeep

- Read the relevant router first and only then the linked files.
- When a file or code area moves, update its router in the same change.
- Add new code-area guidance beside that area; link it from [docs/map/PRODUCT.md](docs/map/PRODUCT.md).
- Keep this file under roughly 8 KB. Put reference material in `docs/` instead of expanding it.
