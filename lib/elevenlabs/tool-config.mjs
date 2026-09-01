/**
 * Translates this repository's eight HTTPS tools into ElevenLabs Agents
 * "webhook" tool configurations.
 *
 * agent/tools.json stays the single source of truth for what the agent can do:
 * the name, the description the model reasons over, and the parameter schema are
 * copied across unchanged. Only the transport-shaped parts are rewritten, because
 * only those differ between vendors. Adding a tool therefore stays a one-file
 * change, as it was before.
 *
 * Two things are deliberately strict rather than lenient:
 *
 *  1. An unrecognised `{{placeholder}}` in a tool header throws. Retell resolved
 *     its own placeholders; ElevenLabs resolves a different set. A placeholder
 *     nobody mapped would otherwise be sent to the backend as the literal text
 *     "{{user_number}}", and the caller-verification check in find-appointment
 *     would fail closed on every single call — at 3am, on a real patient.
 *  2. The tool secret is never inlined. It is referenced by `secret_id` through
 *     the ElevenLabs secret store, so the credential lives in exactly one place
 *     and never lands in a rendered file.
 */

/** Retell placeholder -> the ElevenLabs system dynamic variable that replaces it. */
export const HEADER_VARIABLE_MAP = Object.freeze({
  '{{call_id}}': 'system__conversation_id',
  '{{user_number}}': 'system__caller_id',
});

/** The one placeholder that resolves to a stored secret rather than a variable. */
export const SECRET_PLACEHOLDER = '{{tool_auth_secret}}';

/**
 * Tools that only read. Everything else mutates a calendar, a spreadsheet or a
 * mailbox, and is treated more carefully below.
 */
export const READ_ONLY_TOOLS = Object.freeze([
  'get_current_date', 'check_availability', 'find_appointment', 'search_services',
]);

/** The single tool the backend exposes over GET; the rest are POST. */
export const GET_TOOLS = Object.freeze(['get_current_date']);

/**
 * Webhook tools accept 5..300s. The backend's own work is far quicker than that,
 * but a booking that has already written to Google must not be abandoned by a
 * client-side timeout — that is how a caller is told "sorry, that failed" for an
 * appointment which actually exists.
 */
const READ_TIMEOUT_SECS = 8;
const WRITE_TIMEOUT_SECS = 20;

function headerValue(placeholder, { secretId, toolName }) {
  if (placeholder === SECRET_PLACEHOLDER) {
    if (!secretId) {
      throw new Error(
        `Tool "${toolName}" needs the tool-auth secret, but no secretId was supplied. `
        + 'Create the workspace secret first, then pass its id.',
      );
    }
    return { secret_id: secretId };
  }
  const variable = HEADER_VARIABLE_MAP[placeholder];
  if (variable) return { variable_name: variable };

  throw new Error(
    `Tool "${toolName}" uses the unmapped placeholder ${placeholder}. `
    + `Add it to HEADER_VARIABLE_MAP or give it a secret; refusing to send it as a literal string.`,
  );
}

function requestHeaders(tool, secretId) {
  return Object.fromEntries(
    Object.entries(tool.headers ?? {}).map(([name, placeholder]) => [
      name,
      headerValue(placeholder, { secretId, toolName: tool.name }),
    ]),
  );
}

function hasProperties(schema) {
  return Object.keys(schema?.properties ?? {}).length > 0;
}

/**
 * One repo tool -> one ElevenLabs `tool_config`.
 *
 * `url` must already point at the environment being provisioned; use
 * rewriteToolUrls() from scripts/lib/agent-tools.mjs first, exactly as the
 * previous renderer did.
 */
export function toElevenLabsTool(tool, { secretId } = {}) {
  const isWrite = !READ_ONLY_TOOLS.includes(tool.name);
  const method = GET_TOOLS.includes(tool.name) ? 'GET' : 'POST';

  const apiSchema = {
    url: tool.url,
    method,
    request_headers: requestHeaders(tool, secretId),
  };
  // A GET carries no body, and an empty object schema makes the model believe
  // there is an argument to invent.
  if (method !== 'GET' && hasProperties(tool.parameters)) {
    apiSchema.request_body_schema = tool.parameters;
  }

  return {
    type: 'webhook',
    name: tool.name,
    description: tool.description,
    api_schema: apiSchema,
    response_timeout_secs: isWrite ? WRITE_TIMEOUT_SECS : READ_TIMEOUT_SECS,
    // The clinic prompt already decides when to speak; `force` honours the
    // per-tool `speak_during_execution` the tool file has always carried.
    pre_tool_speech: tool.speak_during_execution ? 'force' : 'off',
    // A caller talking over a booking must not abandon it half-written. Reads
    // stay interruptible so barge-in still feels immediate.
    interruption_mode: isWrite ? 'disable_during_tool' : 'allow',
  };
}

export function toElevenLabsTools(tools, options = {}) {
  return tools.map((tool) => toElevenLabsTool(tool, options));
}
