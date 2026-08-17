import crypto from 'crypto';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { config } from '../config';

export interface CoordinationRecord {
  owner: string;
  state?: string;
  fingerprint?: string;
  data?: string;
  expiresAt: number;
}

const memory = new Map<string, CoordinationRecord & { count?: number }>();
let client: DynamoDBClient | null = null;

function useMemory(): boolean {
  return process.env.NODE_ENV !== 'production' && !config.security.coordinationTable;
}

function getClient(): DynamoDBClient {
  if (!client) client = new DynamoDBClient({ region: config.security.coordinationRegion });
  return client;
}

export function coordinationKey(namespace: string, value: string): string {
  const digest = crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  return `${namespace}#${digest}`;
}

export async function acquireCoordinationKeys(
  keys: string[],
  owner: string,
  expiresAt: number,
  now: number = Date.now(),
): Promise<boolean> {
  const uniqueKeys = [...new Set(keys)].sort();
  if (uniqueKeys.length === 0) return true;
  if (uniqueKeys.length > 100) throw new Error('Too many coordination keys requested.');

  if (useMemory()) {
    for (const key of uniqueKeys) {
      const existing = memory.get(key);
      if (existing && existing.expiresAt > now && existing.owner !== owner) return false;
    }
    for (const key of uniqueKeys) memory.set(key, { owner, expiresAt });
    return true;
  }

  try {
    await getClient().send(new TransactWriteItemsCommand({
      TransactItems: uniqueKeys.map((key) => ({
        Put: {
          TableName: config.security.coordinationTable,
          Item: {
            pk: { S: key },
            owner: { S: owner },
            expires_at: { N: String(expiresAt) },
            ttl: { N: String(Math.ceil(expiresAt / 1000)) },
          },
          ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now OR owner = :owner',
          ExpressionAttributeValues: {
            ':now': { N: String(now) },
            ':owner': { S: owner },
          },
        },
      })),
    }));
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === 'TransactionCanceledException') return false;
    throw error;
  }
}

export async function releaseCoordinationKeys(keys: string[], owner?: string): Promise<void> {
  const uniqueKeys = [...new Set(keys)].sort();
  if (useMemory()) {
    for (const key of uniqueKeys) {
      if (!owner || memory.get(key)?.owner === owner) memory.delete(key);
    }
    return;
  }

  for (let offset = 0; offset < uniqueKeys.length; offset += 100) {
    await getClient().send(new TransactWriteItemsCommand({
      TransactItems: uniqueKeys.slice(offset, offset + 100).map((key) => ({
        Delete: {
          TableName: config.security.coordinationTable,
          Key: { pk: { S: key } },
          ...(owner ? {
            ConditionExpression: 'owner = :owner',
            ExpressionAttributeValues: { ':owner': { S: owner } },
          } : {}),
        },
      })),
    })).catch((error) => {
      if ((error as { name?: string }).name !== 'TransactionCanceledException') throw error;
    });
  }
}

export async function getCoordinationRecord(key: string): Promise<CoordinationRecord | undefined> {
  if (useMemory()) {
    const record = memory.get(key);
    if (!record || record.expiresAt <= Date.now()) return undefined;
    return record;
  }

  const response = await getClient().send(new GetItemCommand({
    TableName: config.security.coordinationTable,
    Key: { pk: { S: key } },
    ConsistentRead: true,
  }));
  const item = response.Item;
  if (!item?.owner?.S || !item.expires_at?.N) return undefined;
  return {
    owner: item.owner.S,
    state: item.state?.S,
    fingerprint: item.fingerprint?.S,
    data: item.data?.S,
    expiresAt: Number(item.expires_at.N),
  };
}

export async function putCoordinationRecord(
  key: string,
  record: CoordinationRecord,
  onlyIfAbsent = false,
): Promise<boolean> {
  if (useMemory()) {
    const existing = memory.get(key);
    if (onlyIfAbsent && existing && existing.expiresAt > Date.now()) return false;
    memory.set(key, record);
    return true;
  }

  try {
    await getClient().send(new PutItemCommand({
      TableName: config.security.coordinationTable,
      Item: {
        pk: { S: key },
        owner: { S: record.owner },
        expires_at: { N: String(record.expiresAt) },
        ttl: { N: String(Math.ceil(record.expiresAt / 1000)) },
        ...(record.state ? { state: { S: record.state } } : {}),
        ...(record.fingerprint ? { fingerprint: { S: record.fingerprint } } : {}),
        ...(record.data ? { data: { S: record.data } } : {}),
      },
      ...(onlyIfAbsent ? {
        ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now',
        ExpressionAttributeValues: { ':now': { N: String(Date.now()) } },
      } : {}),
    }));
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw error;
  }
}

export async function listCoordinationRecords(prefix: string): Promise<Array<{ key: string; record: CoordinationRecord }>> {
  if (useMemory()) {
    return [...memory.entries()]
      .filter(([key, record]) => key.startsWith(prefix) && record.expiresAt > Date.now())
      .map(([key, record]) => ({ key, record }));
  }

  const records: Array<{ key: string; record: CoordinationRecord }> = [];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;
  do {
    const response = await getClient().send(new ScanCommand({
      TableName: config.security.coordinationTable,
      FilterExpression: 'begins_with(pk, :prefix)',
      ExpressionAttributeValues: { ':prefix': { S: prefix } },
      ProjectionExpression: 'pk, owner, #state, expires_at, fingerprint, #data',
      ExpressionAttributeNames: { '#state': 'state', '#data': 'data' },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const item of response.Items ?? []) {
      if (!item.pk?.S || !item.owner?.S || !item.expires_at?.N) continue;
      records.push({
        key: item.pk.S,
        record: {
          owner: item.owner.S,
          state: item.state?.S,
          fingerprint: item.fingerprint?.S,
          data: item.data?.S,
          expiresAt: Number(item.expires_at.N),
        },
      });
    }
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return records;
}

export async function updateCoordinationState(key: string, owner: string, state: string): Promise<void> {
  if (useMemory()) {
    const existing = memory.get(key);
    if (existing?.owner === owner) memory.set(key, { ...existing, state });
    return;
  }
  await getClient().send(new UpdateItemCommand({
    TableName: config.security.coordinationTable,
    Key: { pk: { S: key } },
    UpdateExpression: 'SET #state = :state',
    ConditionExpression: 'owner = :owner',
    ExpressionAttributeNames: { '#state': 'state' },
    ExpressionAttributeValues: {
      ':state': { S: state },
      ':owner': { S: owner },
    },
  }));
}

export async function incrementRateLimit(
  key: string,
  expiresAt: number,
): Promise<number> {
  if (useMemory()) {
    const existing = memory.get(key);
    const count = existing && existing.expiresAt > Date.now() ? (existing.count ?? 0) + 1 : 1;
    memory.set(key, { owner: 'rate-limit', expiresAt, count });
    return count;
  }

  const response = await getClient().send(new UpdateItemCommand({
    TableName: config.security.coordinationTable,
    Key: { pk: { S: key } },
    UpdateExpression: 'SET expires_at = :expires, ttl = :ttl, owner = :owner ADD request_count :one',
    ExpressionAttributeValues: {
      ':one': { N: '1' },
      ':expires': { N: String(expiresAt) },
      ':ttl': { N: String(Math.ceil(expiresAt / 1000)) },
      ':owner': { S: 'rate-limit' },
    },
    ReturnValues: 'UPDATED_NEW',
  }));
  return Number(response.Attributes?.request_count?.N ?? '1');
}

export function resetMemoryCoordinationForTests(): void {
  memory.clear();
}
