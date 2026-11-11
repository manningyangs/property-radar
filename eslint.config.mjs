import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "**/node_modules/**",
      "**/.wrangler/**",
      "**/dist/**",
      ".astro/**",
      "apps/web/.astro/**",
      "collectors/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      // Node 脚本（generate-catalog.mjs 等）的运行时全局
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        fetch: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
      },
    },
  },
  {
    files: ["**/*.{ts,tsx,mjs}"],
    rules: {
      // 中文代码注释与字符串为项目规范，不启用 unicode BOM/规则类限制
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
