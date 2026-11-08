import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ProblemFilter } from './common/problem.filter';
import { JsonLogger } from './observability/json-logger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useLogger(new JsonLogger());
  // Internal endpoints (spec section 3.5) live outside /api/v1 and are never
  // routed by the API Gateway.
  app.setGlobalPrefix('api/v1', { exclude: ['internal/*path'] });
  app.useGlobalFilters(new ProblemFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  const port = Number(process.env.PORT ?? 8080);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
