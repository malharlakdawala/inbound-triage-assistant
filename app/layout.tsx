import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Inbound Triage — Northwind Advisors',
  description: 'LLM-assisted triage of a shared advisory inbox.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
