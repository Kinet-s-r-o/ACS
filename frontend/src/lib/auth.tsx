import { createContext, createSignal, onMount, useContext, type Accessor, type ParentComponent } from 'solid-js';
import { API_BASE, clearStoredSession, request, type User } from './api';

interface AuthContextType {
  user: Accessor<User | null>;
  ready: Accessor<boolean>;
  isAuthenticated: Accessor<boolean>;
  isFullAccess: Accessor<boolean>;
  permissions: Accessor<string[]>;
  hasPermission: (perm: string) => boolean;
  hasAnyPermission: (...perms: string[]) => boolean;
  login: (username: string, password: string) => Promise<{ stage: 'complete' | 'setup' | 'verify'; secret?: string; otpauthURL?: string }>;
  completeTwoFactor: (code: string, setup: boolean) => Promise<void>;
  cancelTwoFactor: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>();

export const AuthProvider: ParentComponent = (props) => {
  const [user, setUser] = createSignal<User | null>(null);
  const [isAuthenticated, setIsAuthenticated] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [permissions, setPermissions] = createSignal<string[]>([]);

  const isFullAccess = () => user()?.role === 'full';
  const hasPermission = (perm: string) => permissions().includes(perm);
  const hasAnyPermission = (...perms: string[]) => perms.some(perm => permissions().includes(perm));

  onMount(async () => {
    // Remove legacy persistent tokens: authentication should not survive a closed browser session.
    localStorage.removeItem('token');
    try {
      const data = await request<{ user: User; permissions: string[] | null }>('/auth/me');
      setUser(data.user);
      setPermissions(data.permissions || []);
    } catch {
      clearStoredSession();
    }
    setIsAuthenticated(Boolean(user()));
    setReady(true);
  });

  const login = async (username: string, password: string) => {
    const response = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      credentials: 'include',
    });
    const body = await response.json().catch(() => ({ error: 'Login service unavailable' }));
    if (!response.ok) throw new Error(body.error || 'Login failed');

    if (body.two_factor_setup_required || body.two_factor_required) {
      setUser(null);
      setPermissions([]);
      setIsAuthenticated(false);
      if (body.two_factor_setup_required) return { stage: 'setup' as const, secret: body.two_factor_secret, otpauthURL: body.two_factor_otpauth_url };
      return { stage: 'verify' as const };
    }

    setUser(body.user);
    setPermissions(body.permissions || []);
    setIsAuthenticated(true);
    return { stage: 'complete' as const };
  };

  const completeTwoFactor = async (code: string, setup: boolean) => {
    const response = await fetch(`${API_BASE}/auth/2fa/${setup ? 'setup' : 'verify'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      credentials: 'include',
    });
    const body = await response.json().catch(() => ({ error: 'Authentication service unavailable' }));
    if (!response.ok) throw new Error(body.error || 'Two-factor verification failed');
    setUser(body.user);
    setPermissions(body.permissions || []);
    setIsAuthenticated(true);
  };

  const cancelTwoFactor = async () => {
    try {
      await fetch(`${API_BASE}/auth/2fa/cancel`, { method: 'POST', credentials: 'include' });
    } catch { /* The short-lived challenge cookie expires automatically. */ }
  };

  const logout = async () => {
    try {
      await request('/auth/logout');
    } catch {
      // Clear local UI state even if the server session already expired.
    } finally {
      clearStoredSession();
      setIsAuthenticated(false);
      setUser(null);
      setPermissions([]);
      window.location.assign('/login');
    }
  };

  return (
    <AuthContext.Provider value={{ user, ready, isAuthenticated, isFullAccess, permissions, hasPermission, hasAnyPermission, login, completeTwoFactor, cancelTwoFactor, logout }}>
      {props.children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
