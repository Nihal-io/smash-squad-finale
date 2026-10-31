import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@huggingface/transformers", "pg", "quickjs-emscripten", "onnxruntime-node", "sharp"],
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
};

export default nextConfig;
