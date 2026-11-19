import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["node_modules/", "state/"] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Every union switch must handle every case (hub events, topic kinds…).
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-empty-function": ["error", { allow: ["arrowFunctions"] }],
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          ignoreVoid: true,
          allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["test", "describe", "it"] }],
        },
      ],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true, allowBoolean: true }],
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
      "@typescript-eslint/prefer-nullish-coalescing": ["error", { ignorePrimitives: { string: true, boolean: true } }],
      eqeqeq: ["error", "always"],
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  {
    // CLIs and tests talk to the terminal.
    files: ["src/cli/**", "src/main.ts", "test/**"],
    rules: { "no-console": "off" },
  },
  {
    files: ["test/**"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
