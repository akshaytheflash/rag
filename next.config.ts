import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * The embedding model is read at runtime from ./models, which is committed to
 * the repository so Vercel builds never depend on the Hugging Face CDN.
 * Next's file tracer does not follow a plain string read, so it has to be
 * told.
 */
const MODEL_FILES = ["./models/**/*"];

/**
 * onnxruntime-node resolves its native library with a *dynamic* require:
 *
 *   require(`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`)
 *
 * The tracer cannot follow that, so we include the linux-x64 build by hand -
 * the only one Vercel can ever run - and exclude the darwin and win32
 * builds, which account for ~240 MB of dead weight.
 */
const ORT_LINUX = ["./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/*"];
const ORT_OTHER_PLATFORMS = [
  "./node_modules/onnxruntime-node/bin/napi-v6/darwin/**",
  "./node_modules/onnxruntime-node/bin/napi-v6/win32/**",
  "./node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/**",
];

const nextConfig: NextConfig = {
  // This project lives in a directory that contains a space, and a stray
  // package-lock.json exists further up the tree. Pinning the root keeps
  // output file tracing from wandering outside the project.
  turbopack: { root: projectRoot },

  outputFileTracingIncludes: {
    "/api/search": [...MODEL_FILES, ...ORT_LINUX],
  },
  outputFileTracingExcludes: {
    "/api/search": ORT_OTHER_PLATFORMS,
  },

  // Load the transformer stack from node_modules at runtime instead of
  // bundling it, so the native ONNX binary is not inlined into the output.
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node", "onnxruntime-common"],

  images: { unoptimized: true },
};

export default nextConfig;
