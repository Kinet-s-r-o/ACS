import type { Component, ParentComponent } from 'solid-js';
import { lazy, Show, createEffect } from 'solid-js';
import { Router, Route, Navigate } from '@solidjs/router';
import { AuthProvider, useAuth } from './lib/auth';
import { useTheme } from './lib/theme';
import { appName } from './lib/appName';
import Layout from './components/Layout';
import { FeedbackProvider } from './components/Feedback';
const Login = lazy(() => import('./pages/Login'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Devices = lazy(() => import('./pages/Devices'));
const WANInterfaces = lazy(() => import('./pages/WANInterfaces'));
const Tasks = lazy(() => import('./pages/Tasks'));
const DeviceDetail = lazy(() => import('./pages/DeviceDetail'));
const Faults = lazy(() => import('./pages/Faults'));
const Firmwares = lazy(() => import('./pages/Firmwares'));
const Security = lazy(() => import('./pages/Security'));
const Settings = lazy(() => import('./pages/Settings'));
const Users = lazy(() => import('./pages/Users'));
const APIDocs = lazy(() => import('./pages/APIDocs'));
const Delivery = lazy(() => import('./pages/Delivery'));
const Provisioning = lazy(() => import('./pages/Provisioning'));
const GeneralSettings = lazy(() => import('./pages/GeneralSettings'));
const RetentionSettings = lazy(() => import('./pages/RetentionSettings'));
const Dictionaries = lazy(() => import('./pages/Dictionaries'));

// Initialize theme on app load
useTheme();

createEffect(() => { document.title = appName(); });

const ProtectedLayout: ParentComponent = (props) => {
  const { isAuthenticated, ready } = useAuth();

  return (
    <Show when={ready()} fallback={<div class="app-loader"><span class="spinner" />Loading control plane…</div>}>
      <Show when={isAuthenticated()} fallback={<Navigate href="/login" />}>
        <Layout>{props.children}</Layout>
      </Show>
    </Show>
  );
};

const App: Component = () => {
  return (
    <AuthProvider>
      <FeedbackProvider>
        <Router root={(props) => <div>{props.children}</div>}>
          <Route path="/login" component={Login} />
          <Route path="/" component={ProtectedLayout}>
            <Route path="/" component={Dashboard} />
            <Route path="/devices" component={Devices} />
            <Route path="/devices/wan-interfaces" component={WANInterfaces} />
            <Route path="/tasks" component={Tasks} />
            <Route path="/device/:serial" component={DeviceDetail} />
            <Route path="/faults" component={Faults} />
            <Route path="/firmwares" component={Firmwares} />
            <Route path="/security" component={Security} />
            <Route path="/settings" component={Settings} />
            <Route path="/settings/users" component={Users} />
            <Route path="/settings/api-docs" component={APIDocs} />
            <Route path="/settings/delivery" component={Delivery} />
            <Route path="/settings/provisioning" component={Provisioning} />
            <Route path="/settings/general" component={GeneralSettings} />
            <Route path="/settings/retention" component={RetentionSettings} />
            <Route path="/settings/dictionaries" component={Dictionaries} />
          </Route>
        </Router>
      </FeedbackProvider>
    </AuthProvider>
  );
};

export default App;
