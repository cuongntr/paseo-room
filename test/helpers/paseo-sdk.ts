import { createPaseoClient } from '@getpaseo/client';

export async function connectFixturePaseo(url: string, timeoutMs = 15_000): Promise<ReturnType<typeof createPaseoClient>> {
  const deadline = Date.now() + timeoutMs;
  do {
    const client = createPaseoClient({ url, appVersion: '0.8.0-beta.1', connectTimeoutMs: 1000,
      reconnect: { enabled: false }, logger: { debug() {}, info() {}, warn() {}, error() {} } });
    try {
      await client.connect();
      return client;
    } catch {
      await client.close().catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } while (Date.now() < deadline);
  throw new Error('Fixture Paseo WebSocket did not become ready within the bounded startup interval.');
}
