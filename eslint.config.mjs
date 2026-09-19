import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // react-hooks/set-state-in-effect (new in eslint-plugin-react-hooks v6, bundled
    // by eslint-config-next) flags the standard "fetch in an effect, setState with
    // the result" pattern used throughout app/page.tsx and components/TicketPanel.tsx.
    // That pattern is explicitly endorsed by the React docs (an effect syncing with
    // an external system), so the rule is disabled rather than restructuring
    // straightforward data loading into something more convoluted.
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
