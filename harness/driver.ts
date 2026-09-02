/**
 * Offline voice-flow driver.
 *
 * Drives the real Express app over HTTP with the same headers the telephony
 * layer sends,
 * records every tool call, and emits transcripts in the shape the pipeline's
 * transcript evaluator expects.
 *
 * Honest scope: the tool sequence, the arguments, the backend responses and the
 * recorded outcomes are all real. The caller/agent utterances are fixtures —
 * there is no language model in this loop. Use these transcripts to prove
 * backend contract and authorization behaviour, never to claim the live agent's
 * spoken behaviour has been evaluated.
 */

import type { Express } from 'express';
import request from 'supertest';

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  status: number;
  response: Record<string, unknown>;
}

export interface Turn {
  role: 'caller' | 'agent';
  text: string;
}

export interface Transcript {
  scenario_id: string;
  turns: Turn[];
  tool_calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  outcome: Record<string, unknown>;
}

export const TOOL_ROUTES: Record<string, { method: 'get' | 'post'; path: string }> = {
  get_current_date: { method: 'get', path: '/current-date' },
  check_availability: { method: 'post', path: '/check-availability' },
  create_appointment: { method: 'post', path: '/create-appointment' },
  find_appointment: { method: 'post', path: '/find-appointment' },
  reschedule_appointment: { method: 'post', path: '/reschedule-appointment' },
  cancel_appointment: { method: 'post', path: '/cancel-appointment' },
  create_callback: { method: 'post', path: '/create-callback' },
  search_services: { method: 'post', path: '/search-services' },
};

export interface CallOptions {
  app: Express;
  scenarioId: string;
  callerPhone: string;
  callId: string;
  toolSecret: string;
  toolAuthHeader?: string;
  callerPhoneHeader?: string;
  callIdHeader?: string;
  /** Use the versioned route prefix instead of the legacy alias. */
  versioned?: boolean;
}

export class VoiceCall {
  readonly calls: ToolCall[] = [];

  private readonly turns: Turn[] = [];

  constructor(private readonly options: CallOptions) {}

  says(text: string): this {
    this.turns.push({ role: 'caller', text });
    return this;
  }

  agentSays(text: string): this {
    this.turns.push({ role: 'agent', text });
    return this;
  }

  /**
   * Invokes one voice tool. `overrides` lets a scenario deliberately omit
   * credentials or spoof a caller number to prove the boundary holds.
   */
  async tool(
    name: keyof typeof TOOL_ROUTES | string,
    args: Record<string, unknown> = {},
    overrides: { headers?: Record<string, string | undefined>; idempotencyKey?: string; record?: boolean } = {},
  ): Promise<ToolCall> {
    const route = TOOL_ROUTES[name];
    if (!route) throw new Error(`Unknown voice tool: ${name}`);

    const prefix = this.options.versioned ? '/v1' : '';
    const headers: Record<string, string> = {};
    const defaults: Record<string, string> = {
      [this.options.toolAuthHeader ?? 'x-tool-auth']: this.options.toolSecret,
      [this.options.callerPhoneHeader ?? 'x-caller-phone']: this.options.callerPhone,
      [this.options.callIdHeader ?? 'x-call-id']: this.options.callId,
    };
    for (const [key, value] of Object.entries({ ...defaults, ...(overrides.headers ?? {}) })) {
      if (value !== undefined) headers[key] = value;
    }
    if (overrides.idempotencyKey) headers['Idempotency-Key'] = overrides.idempotencyKey;

    const agent = request(this.options.app);
    let pending = route.method === 'get'
      ? agent.get(`${prefix}${route.path}`)
      : agent.post(`${prefix}${route.path}`).send(args);
    for (const [key, value] of Object.entries(headers)) pending = pending.set(key, value);

    const response = await pending;
    const call: ToolCall = {
      name: String(name),
      arguments: args,
      status: response.status,
      response: (response.body ?? {}) as Record<string, unknown>,
    };
    if (overrides.record !== false) this.calls.push(call);
    return call;
  }

  transcript(outcome: Record<string, unknown>): Transcript {
    return {
      scenario_id: this.options.scenarioId,
      turns: [...this.turns],
      tool_calls: this.calls.map((call) => ({ name: call.name, arguments: call.arguments })),
      outcome,
    };
  }
}

/** Serialises transcripts to the JSONL format `aivance-pipeline eval --transcripts` reads. */
export function toJsonl(transcripts: Transcript[]): string {
  return `${transcripts.map((item) => JSON.stringify(item)).join('\n')}\n`;
}
