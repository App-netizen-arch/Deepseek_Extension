import { randomBytes } from "node:crypto";

const token = randomBytes(32).toString("hex");
console.log("Better DeepSeek local runtime token:");
console.log(token);
console.log("\nStore this token in the extension's chrome.storage.local. Do not commit it or place it in a public repository.");
