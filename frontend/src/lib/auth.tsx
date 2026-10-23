import { createContext, createSignal, onMount, useContext, type Accessor, type ParentComponent } from 'solid-js';
import { API_BASE, clearStoredSession, request, type User } from './api';

interface AuthContextType {
  user: Accessor<User | null>;
  ready: Accessor<boolean>;
  isAuthenticated: Accessor<boolean>;
  isFullAccess: Accessor<boolean>;
  permissions: Accessor<string[]>;
  hasPermission: (perm: string) => boolean;
  login: (username: string, password: string) => Promise<void>;
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

    setUser(body.user);
    setPermissions(body.permissions || []);
    setIsAuthenticated(true);
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
    <AuthContext.Provider value={{ user, ready, isAuthenticated, isFullAccess, permissions, hasPermission, login, logout }}>
      {props.children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
