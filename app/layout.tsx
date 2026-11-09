import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE_URL = "https://skin-routine-copilot.vercel.app";
const SHARE_TITLE = "Skin Routine Copilot";
const SHARE_DESCRIPTION =
  "A safety-first applied-AI skincare planner: a one-minute check-in becomes a gentle routine from products you already own. Gemini structured output, deterministic guardrails, and synthetic evals.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Skin Routine Copilot",
  description: "Check in with your skin and build a simple, gentle routine from products you already own.",
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: SHARE_TITLE,
    title: SHARE_TITLE,
    description: SHARE_DESCRIPTION,
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Skin Routine Copilot: an AI-generated routine with safety guardrails" }],
  },
  twitter: {
    card: "summary_large_image",
    title: SHARE_TITLE,
    description: SHARE_DESCRIPTION,
    images: ["/og-image.png"],
  },
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
