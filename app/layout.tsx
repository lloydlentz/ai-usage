import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

// Keep in sync with basePath in next.config.ts — metadata icon paths
// aren't auto-prefixed by Next.js the way bundled asset paths are.
const basePath = process.env.NODE_ENV === "production" ? "/ai-usage" : "";

export const metadata: Metadata = {
  title: "Token Burn Dashboard",
  description: "A local dashboard for exact and estimated AI token usage.",
  icons: {
    icon: `${basePath}/favicon.svg`,
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
