/** Browser entry for onnxruntime-web (pinned in package.json). Single-threaded wasm, served from this app's own assets (no CDN). */
import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = { wasm: wasmUrl };
export default ort;
