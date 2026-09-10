import { createPaseoClient } from '@getpaseo/client';
import { createConnection } from 'node:net';

async function tcpReady(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    const finish = (ready: boolean): void => { socket.destroy(); resolve(ready); };
    socket.setTimeout(500, () => { finish(false); });
    socket.once('connect', () => { finish(true); });
    socket.once('error', () => { finish(false); });
  });
}

export async function waitForFixturePaseo(url: string, timeoutMs = 15_000): Promise<void> {
  const endpoint = new URL(url);
  const port = Number(endpoint.port);
  const deadline = Date.now() + timeoutMs;
  while (!(await tcpReady(endpoint.hostname, port))) {
    if (Date.now() >= deadline) throw new Error('Fixture Paseo port did not become ready within the bounded startup interval.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await new Promise(resolve => setTimeout(resolve, 100));
}

export async function connectFixturePaseo(url: string): Promise<ReturnType<typeof createPaseoClient>> {
  await waitForFixturePaseo(url);
  const client = createPaseoClient({ url, appVersion: '0.8.0-beta.1', connectTimeoutMs: 5000,
    reconnect: { enabled: false }, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  await client.connect();
  return client;
}
