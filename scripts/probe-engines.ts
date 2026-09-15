import { probeEngines } from "../src/server/live-analysis.ts";
console.log(JSON.stringify(await probeEngines(), null, 2));
