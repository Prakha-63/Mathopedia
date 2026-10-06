import nodemailer from 'nodemailer';

const APP_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`;

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: +(process.env.SMTP_PORT || 587),
  secure: +(process.env.SMTP_PORT || 587) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
});

export const smtpReady = () =>
  !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);

async function send(to, subject, html) {
  if (!smtpReady())
    throw new Error('SMTP is not configured: set SMTP_HOST, SMTP_USER and SMTP_PASSWORD in .env, then restart.');
  await transport.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, html });
}

const shell = (title, body) => `
  <div style="font-family:Georgia,'Times New Roman',serif;max-width:520px;color:#14171C">
    <div style="font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:#2F52A0">Mathopedia</div>
    <h2 style="font-weight:600;margin:6px 0 16px">${title}</h2>
    ${body}
    <p style="color:#888;font-size:12px;border-top:1px solid #E2E0D9;padding-top:12px;margin-top:22px">
      If you did not request this, you can ignore this email.</p>
  </div>`;

export const sendVerification = (to, token, code) => send(to, 'Confirm your Mathopedia account',
  shell('Confirm your email address', `
    <p>Enter this code in Mathopedia:</p>
    <p style="font-family:ui-monospace,monospace;font-size:30px;letter-spacing:8px;font-weight:700;margin:16px 0">${code}</p>
    <p style="color:#888;font-size:12px">The code expires in 10 minutes.</p>
    <p>Or confirm with one click: <a href="${APP_URL}/verify-email?token=${token}">Confirm email address</a>
       — that link lasts 24 hours.</p>`));

export const sendReset = (to, token) => send(to, 'Reset your Mathopedia password',
  shell('Reset your password', `
    <p><a href="${APP_URL}/reset-password?token=${token}">Set a new password</a></p>
    <p style="color:#888;font-size:12px">This link expires in one hour and can be used once.
       Using it signs you out of every device.</p>`));
