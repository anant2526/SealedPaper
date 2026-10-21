'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from './AuthProvider';
import { SealMark } from './QuorumSeal';
import { roleName, homeFor, navFor } from '@/lib/roles';

export { roleName };

export default function Header() {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const links = user ? navFor(user.role) : [];

  return (
    <header className="guilloche text-paper">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-8 gap-y-3 px-4 py-4 sm:px-6">
        <Link href={user ? homeFor(user.role) : '/'} className="flex items-center gap-2.5 text-lg font-bold tracking-tight">
          <SealMark className="h-7 w-7" />
          SealedPaper
        </Link>
        <nav className="flex flex-wrap gap-1 text-[15px]">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded px-3 py-1.5 ${pathname.startsWith(l.href) ? 'bg-paper/15 font-semibold' : 'text-paper/80 hover:text-paper'}`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        {user && (
          <div className="ml-auto flex items-center gap-4 text-sm">
            <span className="text-paper/80">
              <span className="font-semibold text-paper">{user.name}</span>, {roleName(user.role).toLowerCase()}
            </span>
            <button
              className="rounded border border-paper/30 px-3 py-1.5 hover:border-paper/70"
              onClick={async () => {
                await logout();
                router.replace('/login');
              }}
            >
              Log out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
