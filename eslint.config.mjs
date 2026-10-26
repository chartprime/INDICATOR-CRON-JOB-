import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["**/node_modules/**", "dist-browser-direct/**", "**/.pytest_cache/**", "**/.venv/**", "apps/web/**", "apps/runtime/data/**", "scratch/**", "apps/runtime-python-reference/**", "benchmarks/results/**", "pm/**", ".claude/**"],
  },
  js.configs.recommended,
  {
    files: ["tools/historical-conversion/*.cjs", "ops/linux-host/scripts/*.cjs", "scripts/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: globals.node,
    },
  },
  {
    files: ["apps/runtime/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
  },
];
