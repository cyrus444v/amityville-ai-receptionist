/**
 * Every unit and harness test runs the coordination layer through its in-memory
 * path, so no test ever sends a real DynamoDB expression. That gap shipped two
 * live faults on 3 September 2026: `owner` and `ttl` are reserved words, and
 * using them unescaped made every rate-limited request fail closed with a 503
 * and the background reconciler fail every 60 seconds. The suite was green
 * throughout.
 *
 * This reads the expression strings statically instead. It cannot prove an
 * expression is correct, but it does catch the one mistake that stays invisible
 * until a request reaches AWS.
 *
 * Reference: DynamoDB reserved words —
 * https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ReservedWords.html
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../..');

/** The subset that plausibly appears as an attribute name in this codebase.
 *  Not the full list of ~570 — a name that is never used here cannot break it. */
const RESERVED = [
  'owner', 'ttl', 'state', 'data', 'status', 'timestamp', 'name', 'count',
  'date', 'time', 'value', 'key', 'source', 'type', 'user', 'year', 'zone',
  'hour', 'minute', 'second', 'day', 'month', 'action', 'result', 'order',
];

const EXPRESSION_FIELDS = [
  'UpdateExpression',
  'ConditionExpression',
  'ProjectionExpression',
  'FilterExpression',
  'KeyConditionExpression',
];

const KEYWORDS = ['SET', 'ADD', 'REMOVE', 'DELETE', 'AND', 'OR', 'NOT', 'IN', 'BETWEEN'];
const FUNCTIONS = [
  'attribute_not_exists', 'attribute_exists', 'attribute_type', 'begins_with',
  'contains', 'size', 'if_not_exists', 'list_append',
];

/** Pull every `SomeExpression: '...'` string literal out of a source file. */
function expressionsIn(source: string): Array<{ field: string; text: string }> {
  const found: Array<{ field: string; text: string }> = [];
  for (const field of EXPRESSION_FIELDS) {
    const pattern = new RegExp(`${field}:\\s*'([^']*)'`, 'g');
    for (const match of source.matchAll(pattern)) found.push({ field, text: match[1] });
  }
  return found;
}

/** Bare identifiers in an expression: not `#aliased`, not `:values`, and not
 *  operators or built-in function names. */
function bareIdentifiers(expression: string): string[] {
  return [...expression.matchAll(/(^|[^#:\w])([a-z_][a-z0-9_]*)/gi)]
    .map((match) => match[2])
    .filter((word) => !KEYWORDS.includes(word.toUpperCase()))
    .filter((word) => !FUNCTIONS.includes(word));
}

const FILES = ['src/services/coordination.ts'];

describe('DynamoDB expressions', () => {
  for (const file of FILES) {
    const source = readFileSync(join(repoRoot, file), 'utf8');
    const expressions = expressionsIn(source);

    it(`${file} declares at least one expression to check`, () => {
      // Guards against the regex silently matching nothing after a refactor,
      // which would turn every assertion below into a vacuous pass.
      expect(expressions.length).toBeGreaterThan(0);
    });

    for (const { field, text } of expressions) {
      it(`${file}: ${field} "${text}" uses no unescaped reserved word`, () => {
        const offenders = bareIdentifiers(text)
          .filter((word) => RESERVED.includes(word.toLowerCase()));
        expect(
          offenders,
          `reserved word(s) ${offenders.join(', ')} must be written as #alias with a `
          + 'matching ExpressionAttributeNames entry, or DynamoDB rejects the request '
          + 'at runtime with ValidationException',
        ).toEqual([]);
      });
    }
  }
});
