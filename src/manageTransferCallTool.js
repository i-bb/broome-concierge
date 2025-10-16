import 'dotenv/config';
import { VapiClient, VapiError } from '@vapi-ai/server-sdk';

const {
  VAPI_API_KEY,
  TRANSFER_TOOL_ID,
  TWILIO_BRIDGE_NUMBER,
  FRONT_DESK_DESCRIPTION
} = process.env;

const resolvedTransferToolId = TRANSFER_TOOL_ID || 'c8341ca0-4688-4ac9-8df5-ec3c504ef70b';

if (!VAPI_API_KEY) {
  console.error('Missing VAPI_API_KEY. Add it to your environment or .env file.');
  process.exit(1);
}

const sanitizedBridgeNumber = typeof TWILIO_BRIDGE_NUMBER === 'string' ? TWILIO_BRIDGE_NUMBER.trim() : '';

if (!sanitizedBridgeNumber) {
  console.error('Missing TWILIO_BRIDGE_NUMBER. Set the Twilio bridge number in the environment.');
  process.exit(1);
}

const client = new VapiClient({ token: VAPI_API_KEY });

const basePayload = {
  type: 'transferCall',
  destinations: [
    {
      type: 'number',
      number: sanitizedBridgeNumber,
      description: FRONT_DESK_DESCRIPTION?.trim() || 'Front desk bridge conference line',
      message: 'Connecting you with our front desk now. Please stay on the line.',
      callerId: '{{customer.number}}'
    }
  ]
};

const upsertTool = async () => {
  try {
    if (resolvedTransferToolId) {
      const { type: _omitType, ...updatePayload } = basePayload;
      const updated = await client.tools.update(resolvedTransferToolId, updatePayload);
      console.log('Updated transfer tool:', updated.id);
    } else {
      const created = await client.tools.create(basePayload);
      console.log('Created transfer tool:', created.id);
      console.log('Please store this ID in TRANSFER_TOOL_ID for future updates.');
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
