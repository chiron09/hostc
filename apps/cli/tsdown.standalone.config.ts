import { readFileSync } from "node:fs";

import { defineConfig } from "tsdown";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

/**
 * Standalone build for a self-hosted server: `ws` and `uqr` are bundled, so the
 * single output file runs anywhere Node.js is installed, with no npm install.
 *
 *   HOSTC_STANDALONE_SERVER=https://tunnel.example.com pnpm build:standalone
 *
 * The server baked in here is only the default; `--server` and HOSTC_SERVER
 * still override it, so one file can point at any deployment.
 */
export default defineConfig({
	entry: { "hostc-standalone": "src/main.ts" },
	format: "esm",
	platform: "node",
	outDir: "dist",
	clean: false,
	dts: false,
	// Bundle everything, including the npm dependencies, into one file.
	deps: { onlyBundle: false, alwaysBundle: ["ws", "uqr"] },
	define: {
		__HOSTC_VERSION__: JSON.stringify(version),
		__HOSTC_DEFAULT_SERVER__: JSON.stringify(process.env.HOSTC_STANDALONE_SERVER ?? "https://hostc.dev"),
	},
});
