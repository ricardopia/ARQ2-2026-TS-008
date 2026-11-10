import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * Prometheus exposition (spec section 6). Owns the single MetricsService
 * instance so every metric ends up on the registry /metrics serves.
 */
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class ObservabilityModule {}
