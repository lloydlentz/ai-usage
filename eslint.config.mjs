import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// Flat config for ESLint 9 / Next 16. `next lint` was removed in Next 16, so
// the `lint` npm script drives the ESLint CLI against this file directly.
// eslint-config-next@16 ships native flat configs, so no FlatCompat shim.
export default defineConfig([
  globalIgnores([
    ".next/**",
    "out/**",
    "node_modules/**",
    "next-env.d.ts",
    "data/**",
    "public/**",
  ]),
  nextCoreWebVitals,
  nextTypescript,
]);
