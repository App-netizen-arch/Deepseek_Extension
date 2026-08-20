/**
 * Multi-entry Vite build script for the browser extension.
 * Builds content, background, injected, and sandbox bundles for Chrome/Firefox.
 */
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  copyFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { execSync } from "child_process";
import { zipSync } from "fflate";

const __dirname = dirname(fileURLToPath(import.meta.url));
const targetArg = process.argv.find((arg) => arg.startsWith("--target="));
const target = targetArg ? targetArg.split("=")[1] : "chrome";

if (!new Set(["chrome", "firefox"]).has(target)) {
  console.error(`Unsupported build target: ${target}. Use --target=chrome or --target=firefox.`);
  process.exit(1);
}

console.log(`\n🎯 Target: ${target.toUpperCase()}`);

const distFolderName = `dist-${target}`;
const platformGlobalsFile = "src/platform/globals-chrome.js";
const sharedResolve = {
  alias: {
    "bds-platform-globals": resolve(__dirname, platformGlobalsFile),
  },
};

const sharedDefine = {
  "process.env.NODE_ENV": '"production"',
  "process.env.BDS_TARGET": JSON.stringify(target),
};

const builds = [
  {
    plugins: [svelte()],
    resolve: sharedResolve,
    esbuild: { charset: "ascii" },
    build: {
      emptyOutDir: true,
      outDir: resolve(__dirname, distFolderName),
      rollupOptions: {
        input: resolve(__dirname, "src/content/index.js"),
        output: {
          format: "iife",
          entryFileNames: "content.js",
          assetFileNames: "content.[ext]",
          inlineDynamicImports: true,
        },
        treeshake: false,
      },
      cssCodeSplit: false,
      minify: true,
      sourcemap: false,
    },
    define: sharedDefine,
  },
  {
    plugins: [],
    resolve: sharedResolve,
    esbuild: { charset: "ascii" },
    build: {
      emptyOutDir: false,
      outDir: resolve(__dirname, distFolderName),
      rollupOptions: {
        input: resolve(__dirname, "src/background/index.js"),
        output: {
          format: "iife",
          entryFileNames: "background.js",
          inlineDynamicImports: true,
        },
        treeshake: false,
      },
      minify: true,
      sourcemap: false,
    },
    define: sharedDefine,
  },
  {
    plugins: [],
    resolve: sharedResolve,
    esbuild: { charset: "ascii" },
    build: {
      emptyOutDir: false,
      outDir: resolve(__dirname, distFolderName),
      rollupOptions: {
        input: resolve(__dirname, "src/injected/index.js"),
        output: {
          format: "iife",
          entryFileNames: "injected.js",
          inlineDynamicImports: true,
        },
        treeshake: false,
      },
      minify: true,
      sourcemap: false,
    },
    define: sharedDefine,
  },
  {
    plugins: [],
    resolve: sharedResolve,
    esbuild: { charset: "ascii" },
    build: {
      emptyOutDir: false,
      outDir: resolve(__dirname, distFolderName),
      rollupOptions: {
        input: resolve(__dirname, "src/sandbox/index.js"),
        output: {
          format: "iife",
          entryFileNames: "sandbox.js",
          inlineDynamicImports: true,
        },
        treeshake: false,
      },
      minify: true,
      sourcemap: false,
    },
    define: sharedDefine,
  },
];

function copyRecursiveSync(src, dest) {
  if (statSync(src).isDirectory()) {
    if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
    for (const childItem of readdirSync(src)) {
      copyRecursiveSync(resolve(src, childItem), resolve(dest, childItem));
    }
    return;
  }
  copyFileSync(src, dest);
}

function addDirToZipSync(currentPath, zipData, zipRoot = "") {
  for (const item of readdirSync(currentPath)) {
    const fullPath = resolve(currentPath, item);
    const zipPath = zipRoot ? `${zipRoot}/${item}` : item;
    if (statSync(fullPath).isDirectory()) {
      addDirToZipSync(fullPath, zipData, zipPath);
    } else {
      zipData[zipPath] = new Uint8Array(readFileSync(fullPath));
    }
  }
}

async function run() {
  for (const config of builds) {
    await build({ ...config, configFile: false });
  }

  const distDir = resolve(__dirname, distFolderName);
  const staticSrc = resolve(__dirname, "static");
  const staticDest = resolve(distDir, "static");

  console.log(`📂 Copying static assets to ${distFolderName}...`);
  if (existsSync(staticSrc)) {
    if (!existsSync(staticDest)) mkdirSync(staticDest, { recursive: true });
    for (const item of readdirSync(staticSrc)) {
      if (item === "manifest.json" || item === "sandbox.html") continue;
      copyRecursiveSync(resolve(staticSrc, item), resolve(staticDest, item));
    }
  }

  const manifestPath = resolve(__dirname, "static/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  if (target === "firefox") {
    manifest.browser_specific_settings = {
      gecko: {
        id: "betterdeepseek@goygoyengine.com",
        strict_min_version: "109.0",
        data_collection_permissions: { required: ["none"] },
      },
    };

    if (manifest.background?.service_worker) {
      manifest.background = {
        scripts: [manifest.background.service_worker],
      };
    }

    if (manifest.content_security_policy) {
      delete manifest.content_security_policy.sandbox;
    }
  }

  writeFileSync(resolve(distDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  copyFileSync(resolve(__dirname, "static/sandbox.html"), resolve(distDir, "sandbox.html"));

  console.log("\n🧹 Cleaning non-ASCII characters from bundle...");
  try {
    execSync(`node scripts/sanitize-dist.js --target=${target}`, { stdio: "inherit" });
  } catch (error) {
    console.error("Sanitization failed:", error instanceof Error ? error.message : error);
  }

  console.log(`\n✅ All builds complete. Output ready in ${distFolderName}/`);
  console.log(new Date().toLocaleString());

  console.log(`\n📦 Creating ZIP archive: better-deepseek-${target}.zip...`);
  try {
    const zipData = {};
    addDirToZipSync(distDir, zipData);
    const zipped = zipSync(zipData);
    writeFileSync(resolve(__dirname, `better-deepseek-${target}.zip`), zipped);
    console.log(`✅ ZIP created successfully: better-deepseek-${target}.zip\n`);
  } catch (error) {
    console.error("❌ ZIP creation failed:", error instanceof Error ? error.message : error);
  }
}

async function generateSourceZip() {
  console.log("\n📦 Creating SOURCE CODE archive for Mozilla submission...");
  try {
    const zipData = {};
    const rootFiles = ["build.js", "package.json", "package-lock.json", "README.md", "LICENSE"];
    const rootDirs = ["src", "static", "scripts", "styles"];

    for (const file of rootFiles) {
      const fullPath = resolve(__dirname, file);
      if (existsSync(fullPath)) zipData[file] = new Uint8Array(readFileSync(fullPath));
    }

    for (const dir of rootDirs) {
      const fullPath = resolve(__dirname, dir);
      if (existsSync(fullPath)) addDirToZipSync(fullPath, zipData, dir);
    }

    const zipped = zipSync(zipData);
    writeFileSync(resolve(__dirname, "better-deepseek-source.zip"), zipped);
    console.log("✅ Source code ZIP created successfully: better-deepseek-source.zip\n");
  } catch (error) {
    console.error("❌ Source ZIP creation failed:", error instanceof Error ? error.message : error);
  }
}

async function start() {
  if (process.argv.includes("--source")) {
    await generateSourceZip();
    return;
  }
  await run();
}

start().catch((error) => {
  console.error("Build failed:", error);
  process.exit(1);
});
