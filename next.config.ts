import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  // GitHub Pages serves from /ai-usage when the repo isn't the user root.
  // Remove basePath if you later point a custom domain at it.
  basePath: process.env.NODE_ENV === "production" ? "/ai-usage" : "",
};

export default nextConfig;
