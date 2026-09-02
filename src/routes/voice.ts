import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../utils/logger';
import { initiationVariables } from '../services/call-context';

/**
 * The two hooks the voice vendor calls into.
 *
 * Paths carry no vendor name, matching the rest of the configuration surface:
 * the vendor is a deployment choice, and a second one would reuse these routes
 * rather than add a parallel pair. The *payload* shapes below are vendor
 * specific and are validated as such.
 *
 * Both routes are mounted behind authentication and the PHI clearance gate in
 * src/index.ts. Neither is reachable unauthenticated.
 */

const router = Router();

/** What ElevenLabs sends when an inbound call arrives, before the agent speaks. */
const initiationSchema = z.object({
  caller_id: z.string().optional(),
  agent_id: z.string().optional(),
  called_number: z.string().optional(),
  call_sid: z.string().optional(),
  conversation_id: z.string().optional(),
}).passthrough();

/**
 * POST /voice/call-initiation
 *
 * Answers with the facts the agent needs before its first word: what day it is
 * in the clinic's timezone, whether the clinic is open, and who is calling.
 *
 * This endpoint is on the critical path of every inbound call — the caller is
 * listening to silence while it runs — so it does no I/O and cannot fail on
 * bad input. A malformed body yields the same context with an empty caller
 * number rather than an error, because returning 400 here drops a real call.
 */
router.post('/voice/call-initiation', (req: Request, res: Response) => {
  const parsed = initiationSchema.safeParse(req.body ?? {});
  const body = parsed.success ? parsed.data : {};

  if (!parsed.success) {
    logger.warn('Initiation webhook body did not match the expected shape; answering with defaults', {
      issues: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
  }

  const callerId = body.caller_id ?? '';

  // The caller's number is PHI-adjacent: it identifies a patient. Log that a
  // call started and which conversation it is, never the number itself.
  logger.info('Voice call initiated', {
    conversation_id: body.conversation_id ?? null,
    call_sid: body.call_sid ?? null,
    agent_id: body.agent_id ?? null,
    caller_known: callerId.length > 0,
  });

  res.json({
    type: 'conversation_initiation_client_data',
    dynamic_variables: initiationVariables(callerId),
  });
});

/** The post-call payload, of which we read only the non-PHI envelope. */
const postCallSchema = z.object({
  type: z.string().optional(),
  event_timestamp: z.number().optional(),
  data: z.object({
    conversation_id: z.string().optional(),
    agent_id: z.string().optional(),
    status: z.string().optional(),
    metadata: z.object({
      call_duration_secs: z.number().optional(),
      cost: z.number().optional(),
      termination_reason: z.string().optional(),
    }).passthrough().optional(),
    analysis: z.object({
      call_successful: z.string().optional(),
      transcript_summary: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

/**
 * POST /voice/post-call
 *
 * Records that a call happened and how it ended. Signature-verified upstream.
 *
 * **This deliberately does not persist the transcript.** Decision 0.5 in
 * docs/VOICE_PIPELINE.md wants transcripts kept with a TTL so turn-taking
 * failures stay diagnosable, and that remains the right goal — but two things
 * have to be settled before this route is the place it happens. First, the
 * vendor's own HIPAA guidance requires Zero Retention Mode, under which the
 * transcript is not retained or transmitted at all, so a store built now may
 * have nothing to store. Second, choosing where patient speech comes to rest is
 * a decision with a BAA attached to it, and this service currently has no PHI
 * store that is not the clinic's own Google Workspace.
 *
 * What is captured instead is the diagnostic envelope — duration, termination
 * reason, success classification, cost — which is what actually answers "did
 * turn-taking break", and carries no patient content. When the retention
 * question is settled, the transcript body arrives on `data.transcript` and
 * this is the function that should write it.
 */
router.post('/voice/post-call', (req: Request, res: Response) => {
  const parsed = postCallSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    logger.warn('Post-call webhook body did not match the expected shape');
    // Still 200: a non-200 makes the vendor retry, and after enough retries it
    // disables the webhook entirely. A shape we failed to parse is our problem.
    res.json({ success: true });
    return;
  }

  const data = parsed.data.data ?? {};
  logger.info('Voice call completed', {
    conversation_id: data.conversation_id ?? null,
    agent_id: data.agent_id ?? null,
    status: data.status ?? null,
    duration_secs: data.metadata?.call_duration_secs ?? null,
    termination_reason: data.metadata?.termination_reason ?? null,
    call_successful: data.analysis?.call_successful ?? null,
    transcript_persisted: false,
    vendor: config.voice.vendor,
  });

  res.json({ success: true });
});

export default router;
