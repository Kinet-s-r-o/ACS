import type { Component } from 'solid-js';
import { createSignal, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { Eye, EyeOff, Moon, Sun } from 'lucide-solid';
import QRCode from 'qrcode';
import { useAuth } from '../lib/auth';
import { APP_VERSION } from '../lib/version';
import { appName } from '../lib/appName';
import { useTheme } from '../lib/theme';

const Login: Component = () => {
  const [username, setUsername] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [showPassword, setShowPassword] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [factorStage, setFactorStage] = createSignal<'setup' | 'verify' | null>(null);
  const [factorCode, setFactorCode] = createSignal('');
  const [factorSecret, setFactorSecret] = createSignal('');
  const [factorQR, setFactorQR] = createSignal('');
  const { login, completeTwoFactor, cancelTwoFactor } = useAuth();
  const { isDark, toggleTheme } = useTheme();
  const navigate = useNavigate();

  const handleSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const result = await login(username().trim(), password());
      if (result.stage === 'complete') navigate('/', { replace: true });
      else {
        setFactorStage(result.stage);
        setFactorSecret(result.secret || '');
        if (result.otpauthURL) setFactorQR(await QRCode.toDataURL(result.otpauthURL, { width: 220, margin: 2 }));
      }
    } catch (reason) {
      setError(reason instanceof TypeError
        ? 'The authentication service could not be reached. Check the API service and network connection, then retry.'
        : (reason as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleFactorSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      await completeTwoFactor(factorCode(), factorStage() === 'setup');
      navigate('/', { replace: true });
    } catch (reason) {
      setError(reason instanceof TypeError
        ? 'The authentication service could not be reached. Check the API service and network connection, then retry.'
        : (reason as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main class="min-h-screen grid lg:grid-cols-[1.15fr_.85fr] bg-base">
      <section class="hidden lg:flex flex-col justify-between p-12 border-r border-subtle bg-surface">
        <div class="brand-lockup">
          <div class="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div><div class="brand-name">{appName()}</div><div class="brand-subtitle">Independent CWMP control plane</div></div>
        </div>

        <div class="max-w-2xl">
          <p class="login-kicker">{appName()} / independent ACS runtime</p>
          <h1 class="text-4xl xl:text-5xl font-semibold tracking-[-.035em] text-primary leading-[1.08]">
            CWMP operations, without the middleware.
          </h1>
          <p class="mt-5 text-base text-secondary max-w-xl leading-relaxed">
            Device inventory, provisioning, firmware delivery, fault response, and vendor-neutral telemetry.
          </p>

          <dl class="login-context">
            <dt>Protocol</dt><dd>CWMP 1.0–1.4</dd>
            <dt>Data models</dt><dd>TR-098 / TR-181</dd>
            <dt>Runtime</dt><dd>Independent ACS</dd>
            <dt>Controls</dt><dd>RBAC / audit / blocklist</dd>
          </dl>
        </div>

        <div class="flex items-center justify-between text-[10px] text-muted"><span>{appName()} infrastructure software</span><span>v{APP_VERSION}</span></div>
      </section>

      <section class="min-h-screen flex flex-col">
        <div class="h-16 flex items-center justify-between px-5 lg:px-8 border-b border-subtle">
          <div class="brand-lockup lg:hidden">
            <div class="brand-mark" aria-hidden="true"><span /><span /><span /></div>
            <div><div class="brand-name">{appName()}</div><div class="brand-subtitle">CWMP control plane</div></div>
          </div>
          <span class="hidden lg:block text-[11px] text-muted">Operator authentication</span>
          <button class="icon-button" onClick={toggleTheme} aria-label="Toggle theme">{isDark() ? <Sun size={17} /> : <Moon size={17} />}</button>
        </div>

        <div class="flex-1 flex items-center justify-center px-5 py-10">
          <div class="w-full max-w-[390px]">
            <h2 class="text-2xl font-semibold tracking-[-.025em] text-primary">Operator sign in</h2>
            <p class="text-sm text-muted mt-2">Use your {appName()} control-plane credentials.</p>

            <Show when={error()}>
              <div id="login-error" role="alert" class="mt-6 px-3 py-2.5 border border-red-500/30 bg-red-500/8 rounded-[3px] text-xs text-red-400">{error()}</div>
            </Show>

            <Show when={!factorStage()} fallback={<>
              <div class="mt-6 space-y-4">
                <h3 class="text-base font-semibold text-primary">{factorStage() === 'setup' ? 'Set up an authenticator app' : 'Two-factor verification'}</h3>
                <p class="text-sm text-secondary">{factorStage() === 'setup' ? 'Scan this QR code with an authenticator app, then enter its six-digit code to finish setup.' : 'Enter the six-digit code from your authenticator app.'}</p>
                <Show when={factorStage() === 'setup'}>
                  <Show when={factorQR()}><img src={factorQR()} alt="Authenticator setup QR code" class="mx-auto border border-subtle bg-white p-2" width="220" height="220" /></Show>
                  <div class="text-xs text-muted">Can't scan? Enter this setup key in your authenticator app:</div>
                  <code class="block break-all border border-subtle bg-surface p-3 text-sm text-primary">{factorSecret()}</code>
                </Show>
                <form onSubmit={handleFactorSubmit} class="space-y-4">
                  <div>
                    <label for="authenticator-code" class="block text-[11px] font-semibold text-secondary mb-2">Authenticator code</label>
                    <input id="authenticator-code" class="input h-10 text-center tracking-[.3em]" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,8}" maxlength={8} value={factorCode()} onInput={(event) => setFactorCode(event.currentTarget.value)} required autofocus aria-describedby={factorStage() === 'setup' ? 'factor-code-help' : undefined} />
                    <Show when={factorStage() === 'setup'}><span id="factor-code-help" class="mt-1 block text-xs text-muted">Confirm the QR code pairing with the current six-digit code.</span></Show>
                  </div>
                  <button type="submit" class="btn btn-primary w-full h-10" disabled={loading()}>
                    {loading() ? <><span class="spinner !w-4 !h-4 !border-white/40 !border-t-white" /> Verifying…</> : factorStage() === 'setup' ? 'Verify and finish setup' : 'Verify and sign in'}
                  </button>
                  <button type="button" class="btn btn-secondary w-full" onClick={() => { void cancelTwoFactor(); setFactorStage(null); setFactorCode(''); setError(''); }}>Use another account</button>
                </form>
              </div>
            </>}>
            <form onSubmit={handleSubmit} class="mt-7 space-y-5">
              <div>
                <label for="username" class="block text-[11px] font-semibold text-secondary mb-2">Username</label>
                <input id="username" class="input h-10" value={username()} onInput={(event) => setUsername(event.currentTarget.value)} autocomplete="username" required autofocus placeholder="operator" aria-invalid={Boolean(error())} aria-describedby={error() ? 'login-error' : undefined} />
              </div>
              <div>
                <label for="password" class="block text-[11px] font-semibold text-secondary mb-2">Password</label>
                <div class="relative">
                  <input id="password" class="input h-10 pr-10" type={showPassword() ? 'text' : 'password'} value={password()} onInput={(event) => setPassword(event.currentTarget.value)} autocomplete="current-password" required placeholder="Enter password" aria-invalid={Boolean(error())} aria-describedby={error() ? 'login-error' : undefined} />
                  <button type="button" class="input-reveal" onClick={() => setShowPassword(!showPassword())} aria-label={showPassword() ? 'Hide password' : 'Show password'}>
                    {showPassword() ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <button type="submit" class="btn btn-primary w-full h-10" disabled={loading()}>
                <Show when={loading()} fallback="Sign in to control plane"><span class="spinner !w-4 !h-4 !border-white/40 !border-t-white" /> Authenticating…</Show>
              </button>
            </form>
            </Show>

            <p class="login-session-note">Session-scoped token · Rate-limited authentication · Audited access</p>
          </div>
        </div>
      </section>
    </main>
  );
};

export default Login;
