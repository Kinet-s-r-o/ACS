declare module 'swagger-ui-dist/swagger-ui-bundle.js' {
  export default function SwaggerUI(options: {
    domNode: HTMLElement; spec: Record<string, unknown>; deepLinking: boolean;
    persistAuthorization: boolean; validatorUrl: null; supportedSubmitMethods: string[];
    defaultModelsExpandDepth: number;
  }): { getSystem(): { authActions: { logout(names: string[]): void } } };
}
