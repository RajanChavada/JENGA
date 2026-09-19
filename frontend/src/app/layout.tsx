import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "JENGA",
  description: "Using AI for Construction Project Tracking",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="h-full antialiased">{children}</body>
    </html>
  );
}
