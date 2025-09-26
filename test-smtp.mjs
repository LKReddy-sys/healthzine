import 'dotenv/config';
import nodemailer from 'nodemailer';

// tiny helper
const bool = (v) => String(v ?? '').toLowerCase() === 'true';

// Read env
const host   = process.env.SMTP_HOST;
const port   = parseInt(process.env.SMTP_PORT || '587', 10);
const secure = bool(process.env.SMTP_SECURE ?? (port === 465));
const user   = process.env.SMTP_USER;
let   pass   = process.env.SMTP_PASS;
const from   = process.env.MAIL_FROM || user;

// Gmail app passwords are shown with spaces; remove them just in case
if (pass) pass = pass.replace(/\s+/g, '');

if (!host || !user || !pass) {
  console.error('Missing SMTP env vars. Need SMTP_HOST, SMTP_USER, SMTP_PASS.');
  process.exit(1);
}

// CLI args: to=someone@domain.com subject="..." text="..."
const argv = Object.fromEntries(
  process.argv.slice(2).map(kv => {
    const idx = kv.indexOf('=');
    return idx > -1 ? [kv.slice(0, idx), kv.slice(idx + 1)] : [kv, true];
  })
);

const to      = argv.to || process.env.SMTP_TEST_TO || user; // default: send to yourself
const subject = argv.subject || 'Healthzine SMTP test';
const text    = argv.text || 'If you received this, SMTP is configured correctly. 🎉';

const transporter = nodemailer.createTransport({
  host, port, secure,
  auth: { user, pass }
});

try {
  console.log('Connecting to SMTP...', { host, port, secure, user });
  await transporter.verify();
  console.log('✅ SMTP connection OK');

  const info = await transporter.sendMail({ from, to, subject, text });
  console.log('✅ Message sent:', info.messageId);
  console.log('   To:', to);
} catch (err) {
  console.error('❌ SMTP test failed');
  console.error('   name:', err.name);
  console.error('   code:', err.code);
  console.error('   message:', err.message);
  if (err.response) console.error('   response:', err.response);
  process.exit(2);
}
