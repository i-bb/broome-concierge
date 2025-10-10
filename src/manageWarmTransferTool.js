import 'dotenv/config';
import { VapiClient, VapiError } from '@vapi-ai/server-sdk';

const {
  VAPI_API_KEY,
  WARM_TRANSFER_ENDPOINT,
  WARM_TRANSFER_TOOL_ID,
  WARM_TRANSFER_SERVER_SECRET
} = process.env;

if (!VAPI_API_KEY) {
  console.error('Missing VAPI_API_KEY. Add it to your environment or .env file.');
  process.exit(1);
}

if (!WARM_TRANSFER_ENDPOINT) {
  console.error('Missing WARM_TRANSFER_ENDPOINT. Provide the public URL for the warm transfer webhook.');
  process.exit(1);
}

const client = new VapiClient({ token: VAPI_API_KEY });

const basePayload = {
  type: 'apiRequest',
  name: 'warmTransfer',
  description:
    'Sends an SMS summary to the front desk and, when requested, initiates a Twilio bridge number for live transfer.',
  method: 'POST',
  url: WARM_TRANSFER_ENDPOINT,
  timeoutSeconds: 30,
  headers: {
    type: 'object',
    properties: {
      'Content-Type': {
        type: 'string',
        enum: ['application/json'],
        description: 'Always send JSON payloads.'
      },
      Authorization: WARM_TRANSFER_SERVER_SECRET
        ? {
            type: 'string',
            description: 'Bearer token required by the warm transfer webhook.',
            default: `Bearer ${WARM_TRANSFER_SERVER_SECRET}`
          }
        : undefined
    },
    required: ['Content-Type'],
    additionalProperties: false
  },
  body: {
    type: 'object',
    required: ['guestStatus', 'summary'],
    properties: {
      callId: {
        type: 'string',
        description:
          'Optional identifier for the active call. Provide it only when the true conversationId is available—never send template placeholders.'
      },
      guestStatus: {
        type: 'string',
        description: 'Guest classification (Prospect or In-house with room number when known, e.g., "In-house (Room 302)").'
      },
      guestName: {
        type: 'string',
        description: 'Guest name, if provided.'
      },
      guestContact: {
        type: 'string',
        description: 'Callback number or room number for the guest.'
      },
      summary: {
        type: 'string',
        description: 'Two-sentence recap of the conversation and current request.'
      },
      actionItems: {
        type: 'array',
        items: {
          type: 'string'
        },
        description: 'List the commitments or follow-ups promised to the guest.'
      },
      mood: {
        type: 'string',
        description: 'Brief mood descriptor (e.g., calm, delighted, urgent).'
      },
      transferReason: {
        type: 'string',
        description: 'Why the transfer is being initiated.'
      },
      connectCall: {
        type: 'string',
        description:
          'Set to "bridge" only when the guest explicitly asks to speak with the front desk or the request requires live escalation. Omit for SMS-only notifications.'
      }
    }
  }
};

if (!WARM_TRANSFER_SERVER_SECRET) {
  delete basePayload.headers.properties.Authorization;
}

const upsertTool = async () => {
  try {
    if (WARM_TRANSFER_TOOL_ID) {
      const { type: _omitType, ...updatePayload } = basePayload;
      const updated = await client.tools.update(WARM_TRANSFER_TOOL_ID, updatePayload);
      console.log('Updated warm transfer tool:', updated.id);
    } else {
      const created = await client.tools.create(basePayload);
      console.log('Created warm transfer tool:', created.id);
      console.log('Add this ID to WARM_TRANSFER_TOOL_ID in your .env');
      console.log(created.id);
    }
  } catch (error) {
    if (error instanceof VapiError) {
      console.error('Vapi API error:', error.statusCode, error.message);
      if (error.body) {
        console.error(JSON.stringify(error.body, null, 2));
      }
    } else {
      console.error('Unexpected error:', error);
    }
    process.exit(1);
  }
};

upsertTool();
