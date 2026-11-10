import { createTelegramBootstrap, readTelegramBridge } from './telegram-bootstrap.ts';
import { createProductionStudentClient, STUDENT_CONTRACT_SHA256 } from './owner-client/student-client.ts';
import { StudentFailure } from './transport.ts';

type Environment = Readonly<Record<string, unknown>>;
export type ProductionConfig = Readonly<{ appOrigin: string; apiOrigin: string; apiBaseUrl: string; contractSha256: string }>;
export type ProductionConnectionFactory = Parameters<typeof createTelegramBootstrap>[0]['createConnection'];

function httpsOrigin(value: unknown): string {
  if (typeof value !== 'string' || /[\u0000-\u0020\\]/.test(value)) throw new StudentFailure('protocol', 'ORIGIN_CONFIG_INVALID');
  let url: URL;
  try { url = new URL(value); } catch { throw new StudentFailure('protocol', 'ORIGIN_CONFIG_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new StudentFailure('protocol', 'ORIGIN_CONFIG_INVALID');
  return url.origin;
}

// VITE values are public configuration. No launch/proof/identity comes from env.
export function readProductionConfig(env: Environment, pageOrigin: string): ProductionConfig {
  const appOrigin = httpsOrigin(env.VITE_MINI_APP_ORIGIN);
  const apiOrigin = httpsOrigin(env.VITE_API_ORIGIN);
  if (httpsOrigin(pageOrigin) !== appOrigin) throw new StudentFailure('protocol', 'APP_ORIGIN_MISMATCH');
  if (env.VITE_STUDENT_CONTRACT_SHA256 !== STUDENT_CONTRACT_SHA256)
    throw new StudentFailure('protocol', 'CONTRACT_HASH_MISMATCH');
  // Validate the Backend's production origin/mode policy before touching SDK data.
  try {
    createProductionStudentClient({ mode: 'production', contractSha256: STUDENT_CONTRACT_SHA256,
      baseUrl: apiOrigin + '/api/v1', transport: async () => { throw new Error('CONFIG_VALIDATION_HAS_NO_IO'); } });
  } catch { throw new StudentFailure('protocol', 'API_ENDPOINT_INVALID'); }
  return Object.freeze({ appOrigin, apiOrigin, apiBaseUrl: apiOrigin + '/api/v1', contractSha256: STUDENT_CONTRACT_SHA256 });
}

// Inject this into the Backend-approved constructor when it is handed off. It
// forwards owner-built requests, never invents routes, headers, retries or DTOs.
export function createProductionApiTransport(config: Pick<ProductionConfig, 'apiOrigin'>, fetcher: typeof fetch) {
  return (request: Request): Promise<Response> => {
    const target = new URL(request.url);
    if (target.origin !== config.apiOrigin || !target.pathname.startsWith('/api/v1/')
        || target.username || target.password || target.hash
        || !['GET', 'POST', 'PUT', 'PATCH'].includes(request.method))
      return Promise.reject(new StudentFailure('protocol', 'API_REQUEST_OUT_OF_SCOPE'));
    return fetcher(new Request(request, { credentials: 'omit', cache: 'no-store', redirect: 'error', mode: 'cors' }));
  };
}

export function prepareTelegramEntry(options: {
  env: Environment; pageOrigin: string; scope: unknown;
  createConnection?: ProductionConnectionFactory;
}) {
  const config = readProductionConfig(options.env, options.pageOrigin);
  // No window hook, dynamic URL import or local-client fallback.
  // main.tsx supplies the pinned Backend production connection at compile time.
  if (!options.createConnection) throw new StudentFailure('protocol', 'PRODUCTION_CONNECTION_REQUIRED');
  return createTelegramBootstrap({ apiBaseUrl: config.apiBaseUrl, contractSha256: config.contractSha256,
    readBridge: () => readTelegramBridge(options.scope), createConnection: options.createConnection });
}
