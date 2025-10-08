import 'dotenv/config';
import { VapiClient, VapiError } from '@vapi-ai/server-sdk';

const {
  VAPI_API_KEY,
  BROWSERBASE_AVAILABILITY_ENDPOINT,
  BROWSERBASE_AVAILABILITY_TOOL_ID,
  BROWSERBASE_SERVER_SECRET
} = process.env;

if (!VAPI_API_KEY) {
  console.error('Missing VAPI_API_KEY. Add it to your environment or .env file.');
  process.exit(1);
}

if (!BROWSERBASE_AVAILABILITY_ENDPOINT) {
  console.error('Missing BROWSERBASE_AVAILABILITY_ENDPOINT. Provide the public URL for the Browserbase availability webhook.');
  process.exit(1);
}

const client = new VapiClient({ token: VAPI_API_KEY });

const basePayload = {
  type: 'apiRequest',
  name: 'browserbaseAvailability',
  description:
    'Queries Browserbase automation to verify Broome Hotel availability and rates before quoting guests.',
  method: 'POST',
  url: BROWSERBASE_AVAILABILITY_ENDPOINT,
  timeoutSeconds: 55,
  headers: {
    type: 'object',
    properties: {
      'Content-Type': {
        type: 'string',
        enum: ['application/json'],
        description: 'Always send JSON.'
      },
      Authorization: BROWSERBASE_SERVER_SECRET
        ? {
            type: 'string',
            description: 'Bearer token required by the Browserbase webhook.',
            default: `Bearer ${BROWSERBASE_SERVER_SECRET}`
          }
        : undefined
    },
    required: ['Content-Type'],
    additionalProperties: false
  },
  body: {
    type: 'object',
    required: ['checkInDate', 'checkOutDate'],
    properties: {
      checkInDate: {
        type: 'string',
        description: 'Guest arrival date in YYYY-MM-DD.'
      },
      checkOutDate: {
        type: 'string',
        description: 'Guest departure date in YYYY-MM-DD.'
      },
      adults: {
        type: 'integer',
        description: 'Number of adults in the party.',
        default: 2
      },
      children: {
        type: 'integer',
        description: 'Number of children in the party.',
        default: 0
      },
      rooms: {
        type: 'integer',
        description: 'Number of rooms requested.',
        default: 1
      }
    }
  }
};

if (!BROWSERBASE_SERVER_SECRET) {
  delete basePayload.headers.properties.Authorization;
}

const upsertTool = async () => {
  try {
    if (BROWSERBASE_AVAILABILITY_TOOL_ID) {
      const updated = await client.tools.update(BROWSERBASE_AVAILABILITY_TOOL_ID, basePayload);
      console.log('Updated Browserbase tool:', updated.id);
    } else {
      const created = await client.tools.create(basePayload);
      console.log('Created Browserbase tool:', created.id);
      console.log('Add this ID to BROWSERBASE_AVAILABILITY_TOOL_ID in your .env');
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
