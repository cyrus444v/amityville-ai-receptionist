#!/usr/bin/env node
/**
 * Creates the coordination table in DynamoDB Local.
 *
 * Mirrors infra/cloudformation/voice-agent-core.yml: string partition key `pk`,
 * TTL on `ttl`, on-demand billing. Idempotent — re-running is a no-op.
 *
 * Refuses to run against real AWS: it requires a local endpoint, so a stray
 * invocation cannot create or mutate a production table.
 */

import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';

const endpoint = process.env.AWS_ENDPOINT_URL_DYNAMODB ?? 'http://localhost:8000';
const tableName = process.env.COORDINATION_TABLE ?? 'ai-receptionist-local-coordination';

const host = new URL(endpoint).hostname;
if (!['localhost', '127.0.0.1', 'dynamodb-local', '::1'].includes(host)) {
  console.error(`Refusing to bootstrap against a non-local endpoint: ${endpoint}`);
  process.exit(2);
}

const client = new DynamoDBClient({
  endpoint,
  region: process.env.AWS_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'local',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'local',
  },
});

async function exists() {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') return false;
    throw error;
  }
}

if (await exists()) {
  console.log(`${tableName} already exists at ${endpoint}`);
} else {
  await client.send(new CreateTableCommand({
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  }));
  console.log(`created ${tableName} at ${endpoint}`);
}

try {
  await client.send(new UpdateTimeToLiveCommand({
    TableName: tableName,
    TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
  }));
  console.log('TTL enabled on ttl');
} catch (error) {
  if (error.name === 'ValidationException') console.log('TTL already enabled');
  else throw error;
}

console.log('\nRun the server against it with:');
console.log(`  COORDINATION_TABLE=${tableName} \\`);
console.log(`  AWS_ENDPOINT_URL_DYNAMODB=${endpoint} \\`);
console.log('  AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \\');
console.log('  npm run dev:local');
