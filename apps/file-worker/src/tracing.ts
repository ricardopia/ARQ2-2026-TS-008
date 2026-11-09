import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';

process.env.OTEL_SERVICE_NAME ??= 'file-worker';

// The exporter honours OTEL_EXPORTER_OTLP_ENDPOINT (jaeger:4318 in compose).
const sdk = new NodeSDK({
  resource: resourceFromAttributes({ 'service.name': process.env.OTEL_SERVICE_NAME }),
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [getNodeAutoInstrumentations()],
});

// Must run before pg and amqplib are loaded: instrumentation patches require().
sdk.start();

export function shutdownTracing(): Promise<void> {
  return sdk.shutdown();
}
