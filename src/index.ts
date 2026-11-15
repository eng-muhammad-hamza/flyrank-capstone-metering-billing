import { createApp } from './app';
import { config } from './config';
import { db } from './database';
import { BackgroundJobs } from './jobs';
import { seed } from './scripts/seed';

async function bootstrap() {
  console.log('--- Initializing database schema ---');
  await db.init();

  console.log('--- Running initial seeding if empty ---');
  await seed();

  const app = createApp();

  // Initialize and start background jobs (aggregation, quota monitoring)
  const jobs = new BackgroundJobs();
  jobs.start(60000); // Check every minute

  const server = app.listen(config.port, () => {
    console.log(`====================================================`);
    console.log(`Usage Metering & Billing Engine running`);
    console.log(`Listening on http://localhost:${config.port}`);
    console.log(`Environment: ${config.nodeEnv}`);
    console.log(`Database: ${config.databaseUrl}`);
    console.log(`====================================================`);
  });

  // Graceful shutdown handling
  const shutdown = async () => {
    console.log('\nShutting down gracefully...');
    jobs.stop();
    server.close(async () => {
      await db.close();
      console.log('Server and database connections closed.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
