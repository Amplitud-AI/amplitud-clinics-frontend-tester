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

export const metadata: Metadata = {
  title: "Clinic flow tester — SSR auth build",
  description: "QA harness with Supabase SSR cookies + middleware (clinics-control parity)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <div
          role="status"
          className="sticky top-0 z-50 bg-amber-400 text-amber-950 px-4 py-2 text-center text-sm font-semibold border-b border-amber-600 shadow-md"
        >
          LIVE BUILD v2: SSR auth parity — /login + middleware + cookies · refreshed Jun 22 2026 ~3:25pm
        </div>
        {children}
      </body>
    </html>
  );
}
