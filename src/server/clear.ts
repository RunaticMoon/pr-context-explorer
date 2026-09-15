import { rmSync } from "node:fs";
import { dataDir } from "./fixture.ts";
rmSync(dataDir, { recursive: true, force: true });
console.log("앱 전용 캐시 삭제:", dataDir);
