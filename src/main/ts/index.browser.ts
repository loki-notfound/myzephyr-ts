/**
 * Entry module of the browser build of @loki-notfound/zephyr-ts: dist/zephyr-ts.browser.mjs, one ES
 * module bundled by webpack.browser.js from the same sources as the Node entry and selected by the
 * "browser" condition of the package exports. It exports exactly what index.ts exports.
 *
 * It sets the default locations of the two separately shipped files, the wallet worker and the
 * WebAssembly module, relative to the bundle itself, in the form bundlers recognize: a bundler that
 * consumes the package emits zephyr.worker.js and zephyr.wasm as assets and rewrites these URLs, so
 * an application needs no configuration for them. The relative paths name the files beside the
 * bundle in dist/, not beside this source file. setWorkerDistPath and setWasmModuleUrl override the
 * defaults; called without an argument they restore them.
 */
import LibraryUtils from "./common/LibraryUtils";

LibraryUtils.setDefaultAssetLocations(new URL("./zephyr.worker.js", import.meta.url).href, new URL("./zephyr.wasm", import.meta.url).href);

export * from "./index";
