import type { Component, ParentComponent } from 'solid-js';
import { lazy, Show, createEffect } from 'solid-js';
import { Router, Route, Navigate } from '@solidjs/router';
import { AuthProvider, useAuth } from './lib/auth';
import { useTheme } from './lib/theme';
import { appName } from './lib/appName';
import Layout from './components/Layout';
import SectionPage from './components/SectionPage';
import { FeedbackProvider } from './components/Feedback';
const Login = lazy(() => import('./pages/Login'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Devices = lazy(() => import('./pages/Devices'));
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
const SystemTasks = lazy(() => import('./pages/SystemTasks'));
const AuthenticationSettings = lazy(() => import('./pages/AuthenticationSettings'));
const RadiusAuthenticationSettings = lazy(() => import('./pages/RadiusAuthenticationSettings'));

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
            <Route path="/" component={() => <SectionPage section="fleet"><Dashboard /></SectionPage>} />
            <Route path="/devices" component={() => <SectionPage section="inventory"><Devices /></SectionPage>} />
            <Route path="/devices/wan-interfaces" component={() => <Navigate href="/devices?tab=wans" />} />
            <Route path="/tasks" component={() => <SectionPage section="tasks"><Tasks /></SectionPage>} />
            <Route path="/device/:serial" component={() => <SectionPage section="cpe"><DeviceDetail /></SectionPage>} />
            <Route path="/faults" component={() => <SectionPage section="faults"><Faults /></SectionPage>} />
            <Route path="/firmwares" component={() => <SectionPage section="firmwares"><Firmwares /></SectionPage>} />
            <Route path="/security" component={() => <SectionPage section="security"><Security /></SectionPage>} />
            <Route path="/settings" component={() => <SectionPage section="settings"><Settings /></SectionPage>} />
            <Route path="/settings/users" component={() => <SectionPage section="settings.users"><Users /></SectionPage>} />
            <Route path="/settings/authentication" component={() => <SectionPage section="settings.authentication"><AuthenticationSettings /></SectionPage>} />
            <Route path="/settings/authentication/radius" component={() => <SectionPage section="settings.authentication.radius"><RadiusAuthenticationSettings /></SectionPage>} />
            <Route path="/settings/api-docs" component={() => <SectionPage section="settings.api_docs"><APIDocs /></SectionPage>} />
            <Route path="/settings/delivery" component={() => <SectionPage section="settings.delivery"><Delivery /></SectionPage>} />
            <Route path="/settings/provisioning" component={() => <SectionPage section="settings.provisioning"><Provisioning /></SectionPage>} />
            <Route path="/settings/general" component={() => <SectionPage section="settings.general"><GeneralSettings /></SectionPage>} />
            <Route path="/settings/system-tasks" component={() => <SectionPage section="settings.system_tasks"><SystemTasks /></SectionPage>} />
            <Route path="/settings/retention" component={() => <SectionPage section="settings.database"><RetentionSettings /></SectionPage>} />
            <Route path="/settings/dictionaries" component={() => <SectionPage section="settings.dictionaries"><Dictionaries /></SectionPage>} />
          </Route>
        </Router>
      </FeedbackProvider>
    </AuthProvider>
  );
};

export default App;
