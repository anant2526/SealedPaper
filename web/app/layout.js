import { Suspense } from 'react';
import './globals.css';
import { AuthProvider } from '@/components/AuthProvider';
import Header from '@/components/Header';

export const metadata = {
  title: 'SealedPaper',
  description: 'Exam papers stay encrypted until enough officials unlock them together, each with a key file, a rotating code and a live face scan.',
};

// Pages read the URL and the login state in the browser, so each part streams in
// inside <Suspense>; the static shell (header band, page frame) is served instantly.
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col">
        <AuthProvider>
          <Suspense fallback={<div className="guilloche h-[60px]" />}>
            <Header />
          </Suspense>
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
            <Suspense fallback={<p className="text-ink-soft">Loading…</p>}>{children}</Suspense>
          </main>
        </AuthProvider>
      </body>
    </html>
  );
}
