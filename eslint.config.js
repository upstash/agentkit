import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettier from "eslint-config-prettier";

export default [
  {
    // `examples/**` has its own (Next.js) eslint toolchain; lint it there, not here.
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "**/*.d.ts", "examples/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        // Node + Web platform globals used across the SDK.
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        fetch: "readonly",
        Request: "readonly",
        Response: "readonly",
        Headers: "readonly",
        URL: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        crypto: "readonly",
        Buffer: "readonly",
        ReadableStream: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // Defer to the TS-aware variant so function overload signatures aren't flagged.
      "no-redeclare": "off",
      "@typescript-eslint/no-redeclare": "error",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["**/*.test.ts", "**/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  prettier,
];
