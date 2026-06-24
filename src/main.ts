import * as dotenv from 'dotenv';
dotenv.config({
  path: process.env.NODE_ENV === 'production' ? '.env.production' : '.env',
});

import { NestFactory } from '@nestjs/core';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.enableCors({ origin: process.env.CORS_ORIGIN, credentials: true });
  await app.listen(process.env.PORT ?? 4000);
}
bootstrap();
