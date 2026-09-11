/** @type {import('next').NextConfig} */
const nextConfig = {
  // Every internal import in src/lib/accounting (and elsewhere) uses an explicit ".js"
  // extension on relative imports, e.g. `import { X } from "./types.js"` — this is
  // required by Node's own ESM resolver (this project's package.json sets
  // "type": "module", and the test suite runs the *.ts source directly via `tsx`,
  // which follows Node ESM resolution rules: a relative import needs a real extension,
  // and it maps a ".js" specifier onto the sibling ".ts"/".tsx" file). Next.js's
  // webpack bundler does not do that ".js" -> ".ts" mapping out of the box, so without
  // this it fails at build time with "Module not found: Can't resolve './xyz.js'" for
  // any accounting-engine file reachable from an API route or page — even though the
  // exact same import resolves fine under `npm test`. This tells webpack to try the
  // TypeScript source first (falling back to a literal .js file, of which this project
  // has none under src/), rather than rewriting every import across the codebase.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias || {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
