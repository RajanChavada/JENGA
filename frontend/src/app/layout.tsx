import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'JENGA — construction timeline verification',
  description:
    'Blueprints in, verified work out. Every delay attributed, with evidence, the day it happens.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-full antialiased">{children}</body>
    </html>
  );
}
