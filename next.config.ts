import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * The embedding model is read at runtime from ./models, which is committed to
 * the repository so Vercel builds never depend on the Hugging Face CDN.
 * Next's file tracer cannot follow a plain string read, so it has to be told.
 */
const MODEL_FILES = ["./models/**/*"];

/**
 * @huggingface/transformers is declared in serverExternalPackages, so it is
 * not bundled: it is require()d from node_modules at runtime. That means the
 * tracer never follows into its own dependency, onnxruntime-node, which has to
 * be included explicitly - the package's JavaScript as well as its binaries.
 *
 * onnxruntime-node resolves its native library with a *dynamic* require:
 *
 *   require(`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`)
 *
 * which the tracer cannot follow either, so the linux-x64 build is included
 * by hand. The darwin, win32 and linux/arm64 builds are ~240 MB of dead
 * weight and would push the function past Vercel's 250 MB limit.
 */
const EMBEDDING_RUNTIME = [
  "./node_modules/@huggingface/transformers/**",
  "./node_modules/onnxruntime-common/**",
  "./node_modules/onnxruntime-node/package.json",
  "./node_modules/onnxruntime-node/dist/**",
  "./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/*",
];

const UNUSED_PLATFORM_BINARIES = [
  "./node_modules/onnxruntime-node/bin/napi-v6/darwin/**",
  "./node_modules/onnxruntime-node/bin/napi-v6/win32/**",
  "./node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/**",
];

const nextConfig: NextConfig = {
  // This project lives in a directory containing a space, and a stray
  // package-lock.json exists further up the tree. Pinning the root keeps
  // output file tracing from wandering outside the project.
  turbopack: { root: projectRoot },

  outputFileTracingIncludes: {
    "/api/search": [...MODEL_FILES, ...EMBEDDING_RUNTIME],
  },
  outputFileTracingExcludes: {
    "/api/search": UNUSED_PLATFORM_BINARIES,
  },

  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node", "onnxruntime-common"],

  images: { unoptimized: true },
};

export default nextConfig;
