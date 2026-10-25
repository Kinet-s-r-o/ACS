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
