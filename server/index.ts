import { JsonRepository } from './adapters/jsonRepository.js'
import { buildApp } from './app.js'
import { seedSnapshot } from './seed.js'

const dataFile = process.env.DATA_FILE ?? './data/knowledge-platform.json'
const repository = new JsonRepository(dataFile, seedSnapshot())
const app = buildApp(repository)

await app.listen({
  host: '127.0.0.1',
  port: Number(process.env.PORT ?? 8787),
})
