import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

let transporter = null;

if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    },
  });
  console.log('📧 Mailer ready:', process.env.SMTP_HOST);
} else {
  console.warn('📭 Mailer not configured. Check .env');
}

// ✅ Export both helpers
export function isMailerConfigured() {
  return !!transporter;
}

export async function sendMail(to, subject, text) {
  if (!transporter) throw new Error('Mailer not configured');
  return transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
  });
}
