import { build } from "vite";
// App-owned entry only: do not auto-load .env or local Vite configuration/plugins.
await build({ configFile: false, envDir: false, envPrefix: [] });
