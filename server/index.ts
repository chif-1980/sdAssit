import Fastify from 'fastify';

const app = Fastify({ logger: true });

app.get('/api/health', async () => ({
  ok: true,
  provider: 'local-json',
}));

await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 8787) });
