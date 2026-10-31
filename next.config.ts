import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@huggingface/transformers", "pg", "quickjs-emscripten", "quickjs-emscripten-core", "@jitl/quickjs-wasmfile-release-sync", "@jitl/quickjs-ffi-types", "onnxruntime-node", "sharp", "unpdf", "mammoth"],
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
};

export default nextConfig;
