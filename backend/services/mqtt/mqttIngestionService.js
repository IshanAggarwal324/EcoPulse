/**
 * MQTT ingestion service (Sub-module 1.2.1).
 *
 * Connects to an external MQTT broker (e.g. Mosquitto) over TLS (mqtts://) and
 * subscribes to the canonical telemetry topic pattern
 *   ecopulse/nodes/+/telemetry
 * Each message is authenticated at the broker via per-device credentials +
 * topic ACL (the device may only publish to its own topic), then validated,
 * deduped, and ingested through the unified pipeline.
 *
 * Design notes:
 *  - `mqtt` is a LAZY, optional dependency. It is only required when
 *    MQTT_INGESTION_ENABLED=true, so deployments that use HTTP push or public
 *    APIs pay no cost and need not install the package.
 *  - The broker enforces auth/ACL; this service additionally verifies the
 *    topic's nodeId matches a real, active node bound to a device before
 *    ingesting (defense in depth).
 *  - TLS-only: rejects non-`mqtts://` URLs in production unless explicitly
 *    overridden with MQTT_ALLOW_PLAIN=true (dev only).
 */

const { processDeviceTelemetry } = require('../ingestion/telemetryService');
const ingestionMetrics = require('../ingestion/ingestionMetrics');
const DeviceCredential = require('../../models/DeviceCredential');
const mqttDeviceCache = require('../../utils/mqttDeviceCache');

const TOPIC_PATTERN = /^ecopulse\/nodes\/([^/]+)\/telemetry$/;
const PAYLOAD_MAX_BYTES = parseInt(process.env.MQTT_PAYLOAD_MAX_BYTES || '4096', 10);

let client = null;
let startedAt = null;

const isEnabled = () => String(process.env.MQTT_INGESTION_ENABLED || '').toLowerCase() === 'true';

const isTlsRequired = () => process.env.NODE_ENV === 'production'
  && String(process.env.MQTT_ALLOW_PLAIN || '').toLowerCase() !== 'true';

const loadMqttLibrary = () => {
  try {
    // Lazy require so the package is optional.
    return require('mqtt'); // eslint-disable-line global-require
  } catch {
    return null;
  }
};

/**
 * Resolve the device + node for an inbound MQTT message from its topic.
 * Uses a TTL cache (H23) and a single populated lookup on cache miss.
 */
const resolveFromTopic = async (topicNodeId) => {
  const cached = mqttDeviceCache.get(topicNodeId);
  if (cached) return cached;

  const credential = await DeviceCredential.findOne({ nodeId: topicNodeId, status: 'active' })
    .populate({
      path: 'nodeId',
      select: '_id userId name status nodeType ingestionMode maxCapacityKw',
    })
    .lean()
    .exec();

  if (!credential) {
    const miss = { device: null, node: null };
    mqttDeviceCache.set(topicNodeId, miss);
    return miss;
  }

  const node = credential.nodeId && typeof credential.nodeId === 'object'
    ? credential.nodeId
    : null;
  const device = { ...credential, nodeId: node ? node._id : credential.nodeId };
  const resolved = { device, node };
  mqttDeviceCache.set(topicNodeId, resolved);
  return resolved;
};

const handleMessage = async (topic, rawPayload) => {
  const match = topic.match(TOPIC_PATTERN);
  if (!match) {
    await ingestionMetrics.recordRejection({
      kind: 'invalid_json',
      source: 'mqtt',
      reason: `topic does not match telemetry pattern: ${topic}`,
    });
    return;
  }

  const topicNodeId = match[1];

  // Payload size cap (guardrail 1.2).
  const payloadBytes = Buffer.isBuffer(rawPayload) ? rawPayload.length : Buffer.byteLength(String(rawPayload));
  if (payloadBytes > PAYLOAD_MAX_BYTES) {
    await ingestionMetrics.recordRejection({
      kind: 'invalid_json',
      source: 'mqtt',
      deviceId: null,
      nodeId: topicNodeId,
      reason: `payload exceeds ${PAYLOAD_MAX_BYTES} bytes`,
    });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawPayload.toString());
  } catch {
    await ingestionMetrics.recordRejection({
      kind: 'invalid_json',
      source: 'mqtt',
      nodeId: topicNodeId,
      reason: 'payload is not valid JSON',
    });
    return;
  }

  const { device, node } = await resolveFromTopic(topicNodeId);
  if (!device) {
    await ingestionMetrics.recordRejection({
      kind: 'device_node_mismatch',
      source: 'mqtt',
      nodeId: topicNodeId,
      reason: 'no active device credential bound to topic nodeId',
      payload,
    });
    return;
  }

  await processDeviceTelemetry({
    device,
    node,
    payload,
    transport: 'mqtt',
  });
};

const start = async () => {
  if (!isEnabled()) return false;

  const brokerUrl = process.env.MQTT_BROKER_URL;
  if (!brokerUrl) {
    console.warn('[MQTT] MQTT_INGESTION_ENABLED=true but MQTT_BROKER_URL not set — skipping');
    return false;
  }

  if (isTlsRequired() && !brokerUrl.startsWith('mqtts://')) {
    console.error('[MQTT] Refusing to start: production requires mqtts:// (set MQTT_ALLOW_PLAIN=true to override for dev)');
    return false;
  }

  const mqtt = loadMqttLibrary();
  if (!mqtt) {
    console.error('[MQTT] "mqtt" package not installed. Run `npm install mqtt` to enable MQTT ingestion.');
    return false;
  }

  const topic = process.env.MQTT_TOPIC || 'ecopulse/nodes/+/telemetry';

  return new Promise((resolve) => {
    try {
      client = mqtt.connect(brokerUrl, {
        clientId: process.env.MQTT_CLIENT_ID || `ecopulse-ingest-${process.pid}`,
        username: process.env.MQTT_USERNAME || null,
        password: process.env.MQTT_PASSWORD || null,
        clean: true,
        reconnectPeriod: 5000,
        connectTimeout: 10_000,
        // TLS: reject self-signed certs in production by default; allow in dev.
        rejectUnauthorized: process.env.NODE_ENV === 'production',
      });
    } catch (err) {
      console.error('[MQTT] connect failed:', err.message);
      return resolve(false);
    }

    client.on('connect', () => {
      client.subscribe(topic, { qos: 1 }, (err) => {
        if (err) {
          console.error(`[MQTT] subscribe to "${topic}" failed:`, err.message);
        } else {
          startedAt = new Date();
          console.log(`[MQTT] subscribed to "${topic}" on ${brokerUrl.replace(/:\/\/[^@]*@/, '://')}`);
        }
      });
      resolve(true);
    });

    client.on('message', (topic, payload) => {
      // Fire-and-forget; errors are captured inside the pipeline.
      handleMessage(topic, payload).catch((err) => {
        console.error('[MQTT] message handling error:', err.message);
      });
    });

    client.on('error', (err) => {
      console.error('[MQTT] client error:', err.message);
    });

    client.on('offline', () => {
      console.warn('[MQTT] client offline — will attempt reconnect');
    });

    // Resolve false if connection never establishes within timeout (the
    // reconnect loop keeps trying in the background).
    setTimeout(() => resolve(!!client?.connected), 12_000);
  });
};

const stop = () => {
  if (!client) return;
  try {
    client.end(true);
  } catch {
    /* ignore */
  }
  client = null;
  startedAt = null;
  mqttDeviceCache.clear();
};

const getStatus = () => ({
  enabled: isEnabled(),
  brokerUrl: process.env.MQTT_BROKER_URL ? process.env.MQTT_BROKER_URL.replace(/:\/\/[^@]*@/, '://') : null,
  connected: !!client?.connected,
  startedAt: startedAt ? startedAt.toISOString() : null,
  topic: process.env.MQTT_TOPIC || 'ecopulse/nodes/+/telemetry',
});

module.exports = { start, stop, getStatus, isEnabled, handleMessage, TOPIC_PATTERN };
