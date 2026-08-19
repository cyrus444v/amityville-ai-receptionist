/**
 * Renders a clinic's Retell system prompt from retell/system-prompt.template.txt
 * plus that clinic's tenant configuration.
 *
 * The template holds the reusable machinery — the booking, cancellation,
 * rescheduling and callback flows, the tool rules, the one-question rule, the
 * emergency escalation. Everything a clinic authors for itself, and everything
 * that identifies it, arrives from `tenant.prompt`.
 *
 * Two things are generated from the tenant's *structured* data rather than from
 * its prose, so they can never disagree with what the backend enforces:
 * the business-hours block, and the timezone. A prompt that advertises hours the
 * booking code rejects is a caller being told to call back at a time nobody
 * answers.
 *
 * Written as plain ESM, like infra/render.mjs, so the generator script and the
 * test suite share exactly one implementation.
 */

export const DAY_ORDER = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
];

const PLACEHOLDER = /\{\{([a-z0-9_]+)\}\}/g;

/** "09:00" -> "9 AM", "12:00" -> "12 PM", "09:30" -> "9:30 AM". */
export function formatSpokenTime(value) {
  const [hours, minutes] = value.split(':').map(Number);
  const period = hours < 12 ? 'AM' : 'PM';
  const hour = hours % 12 === 0 ? 12 : hours % 12;
  return minutes === 0 ? `${hour} ${period}` : `${hour}:${String(minutes).padStart(2, '0')} ${period}`;
}

function capitalise(day) {
  return day.charAt(0).toUpperCase() + day.slice(1);
}

/** The spoken hours block: one line per open day, then one line for the rest. */
export function renderBusinessHours(businessHours) {
  const open = DAY_ORDER.filter((day) => !businessHours[day].closed);
  const closed = DAY_ORDER.filter((day) => businessHours[day].closed);

  const lines = open.map((day) => {
    const { open: from, close: to } = businessHours[day];
    return `- ${capitalise(day)}: ${formatSpokenTime(from)} – ${formatSpokenTime(to)}`;
  });
  if (closed.length > 0) lines.push(`- ${closed.map(capitalise).join(', ')}: CLOSED`);
  return lines.join('\n');
}

export function promptValues(tenant) {
  const prompt = tenant.prompt;
  const join = (lines) => lines.join('\n');
  return {
    clinic_name: prompt.spoken_name,
    clinic_locality_long: prompt.locality_long,
    clinic_identity_lines: join(prompt.identity_lines),
    timezone_label: prompt.timezone_label,
    timezone: tenant.timezone,
    provider_short: prompt.provider_short,
    practice_summary: prompt.practice_summary,
    business_hours: renderBusinessHours(tenant.business_hours),
    service_catalogue: join(prompt.service_catalogue),
    patient_priority: join(prompt.patient_priority),
    new_patient_policy: prompt.new_patient_policy,
    insurance_positioning: join(prompt.insurance_positioning),
    specialty_intake: join(prompt.specialty_intake),
    caller_segments: join(prompt.caller_segments),
    objection_handling: join(prompt.objection_handling),
    brand_messaging: join(prompt.brand_messaging),
  };
}

export function renderSystemPrompt({ templateText, tenant }) {
  const values = promptValues(tenant);

  // A substituted value may itself name a placeholder — the practice summary
  // states the clinic name — so substitute until the text stops changing.
  let rendered = templateText;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = rendered.replace(PLACEHOLDER, (whole, key) => (values[key] === undefined ? whole : values[key]));
    if (next === rendered) break;
    rendered = next;
  }

  const unresolved = [...new Set([...rendered.matchAll(PLACEHOLDER)].map((match) => match[1]))];
  if (unresolved.length > 0) {
    throw new Error(
      `Unresolved prompt placeholders: ${unresolved.join(', ')}. `
      + 'Add them to the tenant\'s "prompt" block.',
    );
  }
  return rendered;
}
