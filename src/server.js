import 'dotenv/config';
import express from 'express';
import { z } from 'zod';
import fetchBroomeAvailability from './services/browserbaseAvailability.js';
import initiateWarmTransfer, { getActiveBridgeConference } from './services/warmTransfer.js';

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

    const resolvedCallId = ((raw) => {
      const trimmed = raw?.trim();
      if (trimmed && !trimmed.includes('{{')) {
        return trimmed;
      }
      return headerConversationId?.trim();
    })(payload.callId);

    if (!resolvedCallId) {
      throw new Error('Missing call identifier. Provide callId or ensure x-vapi-conversation-id header is set.');
    }

    const result = await initiateWarmTransfer({
      ...payload,
      callId: resolvedCallId,
      connectCall: payload.connectCall === true || payload.connectCall === 'bridge'
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

const port = Number(process.env.PORT) || 8787;

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`Browserbase availability server listening on ${port}`);
  });
}

export default app;
