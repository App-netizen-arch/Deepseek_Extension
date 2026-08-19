import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root=path.resolve(new URL("..",pathToFileURL(import.meta.url)).pathname);
const manifest=JSON.parse(await fs.readFile(path.join(root,"manifest.json"),"utf8"));
if(manifest.manifest_version!==3)throw new Error("manifest_version must be 3");
if(manifest.background?.service_worker!=="service-worker.js")throw new Error("missing MV3 service worker");
if(!manifest.content_scripts?.some(x=>x.matches?.includes("https://chat.deepseek.com/*")))throw new Error("DeepSeek content script match missing");
for(const file of ["manifest.json","service-worker.js","content-script.js","options.html","options.js"]){await fs.access(path.join(root,file));}
console.log("Chrome MV3 manifest/package smoke check passed.");
