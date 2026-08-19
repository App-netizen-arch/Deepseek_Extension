import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const extensionPath = path.resolve("chrome-extension");
const token = process.env.BDS_RUNTIME_TOKEN;
if (!token || token.length < 32) throw new Error("BDS_RUNTIME_TOKEN is required for Chrome E2E");
const userDataDir = path.resolve(".tmp-extension-e2e");
await fs.rm(userDataDir,{recursive:true,force:true});
const context = await chromium.launchPersistentContext(userDataDir,{headless:true,args:[`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`]});
try {
  let worker;
  for (const w of context.serviceWorkers()) { worker=w; break; }
  if(!worker) worker=await context.waitForEvent("serviceworker",{timeout:10000});
  const extensionId=new URL(worker.url()).host;
  const page=await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.locator("#token").fill(token);
  await page.locator("#save").click();
  await page.locator("#test").click();
  await page.waitForTimeout(250);
  const text=await page.locator("#status").textContent();
  if(!text?.includes("Runtime online")) throw new Error(`runtime status failed: ${text}`);
  const result=await page.evaluate(()=>new Promise(resolve=>chrome.runtime.sendMessage({type:"runtime/status"},resolve)));
  if(!result?.ok) throw new Error("service worker runtime/status request failed");
  console.log(`Chrome MV3 E2E passed for extension ${extensionId}.`);
} finally { await context.close(); await fs.rm(userDataDir,{recursive:true,force:true}); }
