import 'dotenv/config';
import express from 'express';
import { z } from 'zod';
import fetchBroomeAvailability from './services/browserbaseAvailability.js';
import initiateWarmTransfer, {
  getActiveBridgeConference,
  placeFrontDeskTestCall
} from './services/warmTransfer.js';

const app = express();
app.use(express.json());

const parseAuthorization = (req, expectedSecret) => {
  if (!expectedSecret) return true;
  const authHeader = req.headers.authorization;
  return authHeader === `Bearer ${expectedSecret}`;
};

app.post('/browserbase/availability', async (req, res) => {
  try {
    const expectedSecret = process.env.BROWSERBASE_SERVER_SECRET;
    if (expectedSecret && !parseAuthorization(req, expectedSecret)) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const {
      checkInDate,
      checkOutDate,
      adults = 2,
      children = 0,
      rooms = 1
    } = req.body || {};

    const result = await fetchBroomeAvailability({
      checkInDate,
      checkOutDate,
      adults: Number(adults) || 2,
      children: Number(children) || 0,
      rooms: Number(rooms) || 1
    });

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

const warmTransferSchema = z.object({
  callId: z.string().optional(),
  guestStatus: z.string().min(1),
  guestName: z.string().optional(),
  guestContact: z.string().optional(),
  summary: z.string().min(1),
  actionItems: z.union([z.string(), z.array(z.string())]).optional(),
  mood: z.string().optional(),
  transferReason: z.string().optional(),
  connectCall: z.union([z.boolean(), z.literal('bridge')]).optional()
});

const extractGuestCallSid = (req) => {
  const headerCandidates = [
    req.headers['x-vapi-twilio-call-sid'],
    req.headers['x-vapi-call-sid'],
    req.headers['x-twilio-call-sid'],
    req.headers['x-call-sid']
  ];

  for (const candidate of headerCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return undefined;
};

app.post('/tools/warm-transfer', async (req, res) => {
  try {
    const expectedSecret = process.env.WARM_TRANSFER_SERVER_SECRET;
    if (expectedSecret && !parseAuthorization(req, expectedSecret)) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const payload = warmTransferSchema.parse(req.body || {});
    const headerConversationId =
      typeof req.headers['x-vapi-conversation-id'] === 'string'
        ? req.headers['x-vapi-conversation-id']
        : undefined;
    const guestCallSid = extractGuestCallSid(req);

    const resolvedCallId = ((raw) => {
      const trimmed = raw?.trim();
      if (trimmed && !trimmed.includes('{{')) {
        return trimmed;
      }
      return headerConversationId?.trim();
    })(payload.callId);

    const result = await initiateWarmTransfer({
      ...payload,
      callId: resolvedCallId,
      connectCall: payload.connectCall === true || payload.connectCall === 'bridge',
      guestCallSid
    });

    res.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

const escapeXml = (value) =>
  value.replace(/[<>&"']/g, (char) => {
    switch (char) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      case "'":
        return '&apos;';
      default:
        return char;
    }
  });

const extractConferenceName = (req) => {
  const queryConference = typeof req.query?.conference === 'string' ? req.query.conference : undefined;
  if (queryConference) return queryConference;

  const bodyConference =
    typeof req.body?.conference === 'string'
      ? req.body.conference
      : typeof req.body?.ConferenceName === 'string'
      ? req.body.ConferenceName
      : undefined;

  return bodyConference;
};

app.post(
  '/twilio/voice/join-conference',
  express.urlencoded({ extended: false }),
  (req, res) => {
    let conferenceName = extractConferenceName(req);

    if (!conferenceName) {
      const candidates = new Set();

      if (typeof req.body?.To === 'string') {
        candidates.add(req.body.To.trim());
      }

      if (typeof req.body?.Called === 'string') {
        candidates.add(req.body.Called.trim());
      }

      if (typeof process.env.TWILIO_BRIDGE_NUMBER === 'string') {
        candidates.add(process.env.TWILIO_BRIDGE_NUMBER.trim());
      }

      for (const candidate of candidates) {
        const resolved = getActiveBridgeConference(candidate);
        if (resolved) {
          conferenceName = resolved;
          break;
        }
      }
    }

    if (!conferenceName) {
      return res
        .status(400)
        .type('application/json')
        .send({ success: false, error: 'Missing conference identifier.' });
    }

    const escaped = escapeXml(conferenceName);
    res
      .status(200)
      .type('text/xml')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Dial>\n    <Conference waitUrl="" endConferenceOnExit="false">${escaped}</Conference>\n  </Dial>\n</Response>`
      );
  }
);

app.get('/test/front-desk-call', async (req, res) => {
  try {
    const expectedSecret =
      process.env.TEST_FRONT_DESK_CALL_SECRET || process.env.WARM_TRANSFER_SERVER_SECRET;

    if (expectedSecret) {
      const headerAuthorized = parseAuthorization(req, expectedSecret);
      const querySecret =
        typeof req.query?.secret === 'string' && req.query.secret.trim() === expectedSecret;

      if (!headerAuthorized && !querySecret) {
        return res.status(401).type('text/plain').send('Unauthorized');
      }
    }

    const result = await placeFrontDeskTestCall();

    res
      .status(200)
      .type('text/html')
      .send(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Front Desk Call Triggered</title>
    <style>
      body { font-family: sans-serif; margin: 2rem; line-height: 1.6; }
      code { background: #f4f4f4; padding: 0.2rem 0.4rem; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>Front Desk Call Triggered</h1>
    <p>Twilio is dialing <strong>${result.dialedNumber}</strong> using call SID <code>${result.callSid}</code>.</p>
    <p>If answered, the call will join conference <code>${result.conferenceName}</code>.</p>
    <p>Twilio will fetch instructions from <code>${result.voiceUrl}</code>.</p>
    <p>You can close this tab once the test completes.</p>
  </body>
</html>`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).type('application/json').send({ success: false, error: message });
  }
});

const port = Number(process.env.PORT) || 8787;

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`Browserbase availability server listening on ${port}`);
  });
}

export default app;
