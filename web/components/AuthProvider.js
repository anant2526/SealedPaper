'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const { user } = await api('/auth/me');
      setUser(user);
    } catch {
      // Access token may have expired: try the refresh token once.
      try {
        const { user } = await api('/auth/refresh', { method: 'POST' });
        setUser(user);
      } catch {
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, setUser, loading, reload, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

/** Use on pages that need a logged-in user (optionally with one of `roles`). */
export function useRequireAuth(roles) {
  const auth = useAuth();
  const router = useRouter();
  const allowed = auth.user && (!roles || roles.includes(auth.user.role));
  useEffect(() => {
    if (auth.loading) return;
    if (!auth.user) router.replace('/login');
    else if (!allowed) router.replace('/dashboard');
  }, [auth.loading, auth.user, allowed, router]);
  return { ...auth, ready: !auth.loading && allowed };
}
