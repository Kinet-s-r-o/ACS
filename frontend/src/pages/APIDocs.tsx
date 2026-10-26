import { createResource, createEffect, onCleanup, Show, type Component } from 'solid-js';
import SwaggerUI from 'swagger-ui-dist/swagger-ui-bundle.js';
import 'swagger-ui-dist/swagger-ui.css';
import { api, API_BASE } from '../lib/api';
import PageHeader from '../components/PageHeader';
import { ResourceError } from '../components/ResourceState';

const APIDocs: Component = () => {
  const [spec, { refetch }] = createResource(api.getIntegrationSpec);
  let host!: HTMLDivElement;
  createEffect(() => {
    const document = spec();
    if (!document) return;
    const ui = SwaggerUI({
      domNode: host, spec: { ...document, servers: [{ url: API_BASE }] },
      deepLinking: true, persistAuthorization: false, validatorUrl: null,
      supportedSubmitMethods: ['get', 'post', 'delete'], defaultModelsExpandDepth: -1,
    });
    onCleanup(() => { ui.getSystem().authActions.logout(['bearerAuth']); host.replaceChildren(); });
  });
  return (
    <div class="space-y-5">
      <PageHeader title="API documentation" description="Billing integration: CPE parameters by serial number, asynchronous CWMP tasks and user-linked API tokens.">
        <a class="btn btn-secondary" href={`${API_BASE}/openapi.json`} download="acs-openapi.json" target="_blank" rel="noreferrer">OpenAPI JSON</a>
      </PageHeader>
      <p class="text-sm text-muted">Generate tokens in Users and Roles using the key button. Use Authorize below to test the integration API. Authorization is kept only in memory. Token administration requires a console session and CSRF protection; use the Users and Roles screen.</p>
      <Show when={spec.loading}><p class="text-sm text-muted" role="status">Loading API documentation…</p></Show>
      <Show when={spec.error}><ResourceError title="Could not load API documentation" description="Retry when the API is available." onRetry={() => void refetch()} /></Show>
      <div ref={host} data-theme="light" class="api-documentation card p-4 overflow-x-auto" />
    </div>
  );
};

export default APIDocs;
