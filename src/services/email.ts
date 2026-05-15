import { Resend } from 'resend';
import { logger } from '../utils/logger';

let _resend: Resend | null = null;

function getResend(): Resend {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error('RESEND_API_KEY is not set.');
    _resend = new Resend(key);
  }
  return _resend;
}

export interface ConfirmationEmailParams {
  to: string;
  caller_name: string;
  service: string;
  date: string;         // YYYY-MM-DD
  time: string;         // HH:MM
  duration_minutes: number;
}

function formatDate(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function formatTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

export async function sendBookingConfirmation(params: ConfirmationEmailParams): Promise<void> {
  const resend = getResend();

  const fromName = process.env.BUSINESS_NAME || 'Amityville Acupuncture';
  const fromEmail = process.env.EMAIL_FROM || 'appointments@amityvilleacupuncture.com';
  const replyTo = process.env.EMAIL_REPLY_TO || fromEmail;

  const formattedDate = formatDate(params.date);
  const formattedTime = formatTime(params.time);

  const { error } = await resend.emails.send({
    from: `${fromName} <${fromEmail}>`,
    to: params.to,
    replyTo: replyTo,
    subject: `Your appointment is confirmed — ${params.service} on ${formattedDate}`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:#2d6a4f;padding:32px 40px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:600;letter-spacing:0.3px;">
                ${fromName}
              </h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              <p style="margin:0 0 8px;color:#333;font-size:16px;">Hi ${params.caller_name},</p>
              <p style="margin:0 0 32px;color:#555;font-size:15px;line-height:1.6;">
                Your appointment has been confirmed. We look forward to seeing you!
              </p>

              <!-- Appointment card -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f7f4;border-left:4px solid #2d6a4f;border-radius:4px;margin-bottom:32px;">
                <tr>
                  <td style="padding:24px 28px;">
                    <p style="margin:0 0 14px;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px;font-weight:600;">APPOINTMENT DETAILS</p>
                    <table cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding:4px 0;color:#555;font-size:14px;width:80px;">Service</td>
                        <td style="padding:4px 0;color:#1a1a1a;font-size:14px;font-weight:600;">${params.service}</td>
                      </tr>
                      <tr>
                        <td style="padding:4px 0;color:#555;font-size:14px;">Date</td>
                        <td style="padding:4px 0;color:#1a1a1a;font-size:14px;font-weight:600;">${formattedDate}</td>
                      </tr>
                      <tr>
                        <td style="padding:4px 0;color:#555;font-size:14px;">Time</td>
                        <td style="padding:4px 0;color:#1a1a1a;font-size:14px;font-weight:600;">${formattedTime}</td>
                      </tr>
                      <tr>
                        <td style="padding:4px 0;color:#555;font-size:14px;">Duration</td>
                        <td style="padding:4px 0;color:#1a1a1a;font-size:14px;font-weight:600;">${params.duration_minutes} minutes</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="margin:0;color:#555;font-size:14px;line-height:1.6;">
                Need to reschedule or cancel? Call us and our AI receptionist will take care of it right away.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#fafafa;border-top:1px solid #eee;padding:20px 40px;text-align:center;">
              <p style="margin:0;color:#aaa;font-size:12px;">${fromName} · Amityville, NY</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim(),
  });

  if (error) {
    logger.error('Failed to send confirmation email', { error: error.message });
    throw error;
  }

  logger.info('Confirmation email sent', { service: params.service, date: params.date });
}
