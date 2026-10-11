import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/** Flat config, as shipped by eslint-config-next 16. */
const config = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".cache/**",
      "models/**",
      ".agents/**",
      "skills/**",
      "next-env.d.ts",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // Ingestion scripts and tests log to stdout by design.
    files: ["scripts/**/*.ts", "src/ingest/**/*.ts", "tests/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
];

export default config;
