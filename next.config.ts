import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  // GitHub Pages serves from /ai-usage-claude when the repo isn't the user root.
  // Remove basePath if you later point a custom domain at it.
  basePath: "/ai-usage",
};

export default nextConfig;
