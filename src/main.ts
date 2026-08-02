import * as dotenv from 'dotenv';
dotenv.config({
  path: process.env.NODE_ENV === 'production' ? '.env.production' : '.env',
});

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import * as cookieParser from 'cookie-parser';
import { json } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(cookieParser());
  app.use(json({ limit: '5mb' }));
  app.setGlobalPrefix('api');
  app.enableCors({ origin: process.env.CORS_ORIGIN, credentials: true });
  // Global request validation (AUDIT-REPORT.md H1): previously there was no
  // ValidationPipe anywhere, so malformed bodies reached Postgres directly
  // and produced 500s that leaked schema details (confirmed: null `ip` in
  // DevicesService.create, null `metric` in SlaService.create). whitelist +
  // forbidNonWhitelisted also mitigates H2 by stripping/rejecting unexpected
  // fields on write bodies.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.listen(process.env.PORT ?? 4000);
}
bootstrap();
