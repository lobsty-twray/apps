const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: 'Too many submissions. Try again later.' } });

const DEST_EMAIL = process.env.DEST_EMAIL || 'rayscriptsjs@gmail.com';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

let transporter = null;
if (SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}

app.post('/submit', limiter, async (req, res) => {
  const { name, email, company, project_type, budget, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email, and message are required' });
  }

  const text = `--- New buildwithray.dev Inquiry ---

Name: ${name}
Email: ${email}
Company: ${company || 'N/A'}
Project Type: ${project_type || 'N/A'}
Budget: ${budget || 'N/A'}

Message:
${message}

---
Sent from buildwithray.dev contact form`;

  const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const html = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#111;color:#e8e8ed;padding:24px;border-radius:12px">
<h2 style="color:#f59e0b;margin:0 0 16px">New Inquiry from buildwithray.dev</h2>
<table style="width:100%;border-collapse:collapse">
<tr><td style="padding:8px 0;color:#9d9daa;width:120px">Name</td><td style="padding:8px 0">${esc(name)}</td></tr>
<tr><td style="padding:8px 0;color:#9d9daa">Email</td><td style="padding:8px 0"><a href="mailto:${esc(email)}" style="color:#f59e0b">${esc(email)}</a></td></tr>
<tr><td style="padding:8px 0;color:#9d9daa">Company</td><td style="padding:8px 0">${esc(company||'N/A')}</td></tr>
<tr><td style="padding:8px 0;color:#9d9daa">Project</td><td style="padding:8px 0">${esc(project_type||'N/A')}</td></tr>
<tr><td style="padding:8px 0;color:#9d9daa">Budget</td><td style="padding:8px 0">${esc(budget||'N/A')}</td></tr>
</table>
<div style="margin-top:16px;padding:16px;background:#1a1a24;border-radius:8px;border-left:3px solid #f59e0b">
<p style="color:#9d9daa;margin:0 0 4px;font-size:12px">MESSAGE</p>
<p style="margin:0;white-space:pre-wrap">${esc(message)}</p>
</div></div>`;

  if (transporter) {
    try {
      await transporter.sendMail({
        from: `"Build With Ray" <${SMTP_USER}>`,
        replyTo: email,
        to: DEST_EMAIL,
        subject: `New inquiry from ${name} — buildwithray.dev`,
        text, html
      });
      console.log('Email sent to', DEST_EMAIL, 'from', name, email);
      res.json({ success: true });
    } catch (err) {
      console.error('Email failed:', err.message);
      res.status(500).json({ error: 'Failed to send. Try emailing directly.' });
    }
  } else {
    console.log('NO SMTP CONFIG — logging submission:');
    console.log(text);
    res.json({ success: true, note: 'Logged (no SMTP configured yet)' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(3000, () => console.log('Form API running on :3000'));
