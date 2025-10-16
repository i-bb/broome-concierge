import twilio from 'twilio';
import { randomUUID } from 'crypto';

const BRIDGE_ENTRY_TTL_MS = 10 * 60 * 1000;
const BRIDGE_REUSE_WINDOW_MS = 60 * 1000;

const normalizeBridgeNumber = (value) => {
  if (typeof value !== 'string') return '';
  return value.replace(/[\s-]/g, '');
};

const activeBridgeQueues = new Map();

const cleanupQueue = (queue) => {
  if (!Array.isArray(queue) || queue.length === 0) {
    return [];
  }
  const now = Date.now();
  while (queue.length > 0) {
    const entry = queue[0];
    if (!entry) {
      queue.shift();
      continue;
    }
    if (entry.expiresAt <= now) {
      queue.shift();
      continue;
    }
    if (typeof entry.lastServedAt === 'number' && entry.lastServedAt + BRIDGE_REUSE_WINDOW_MS <= now) {
      queue.shift();
      continue;
    }
    break;
  }
  return queue;
};

const registerBridgeConference = (bridgeNumber, conferenceName) => {
  const normalized = normalizeBridgeNumber(bridgeNumber);
  if (!normalized || !conferenceName) {
    return;
  }

  const queue = cleanupQueue(activeBridgeQueues.get(normalized) ?? []);
  queue.push({
    conferenceName,
    expiresAt: Date.now() + BRIDGE_ENTRY_TTL_MS,
    lastServedAt: undefined
  });
  activeBridgeQueues.set(normalized, queue);
};

export const getActiveBridgeConference = (bridgeNumber) => {
  const normalized = normalizeBridgeNumber(bridgeNumber);
  if (!normalized) {
    return null;
  }

  const queue = cleanupQueue(activeBridgeQueues.get(normalized) ?? []);

  if (queue.length === 0) {
    activeBridgeQueues.delete(normalized);
    return null;
  }

  const entry = queue[0];
  entry.lastServedAt = Date.now();
  activeBridgeQueues.set(normalized, queue);
  return entry.conferenceName;
};

const SMS_ENV_VARS = {
  TWILIO_ACCOUNT_SID: 'Twilio account SID',
  TWILIO_AUTH_TOKEN: 'Twilio auth token',
  TWILIO_SMS_FROM: 'Twilio SMS-enabled sender number (E.164)',
  FRONT_DESK_SMS_TO: 'Front desk SMS recipient number (E.164)'
};

const VOICE_ENV_VARS = {
  TWILIO_VOICE_FROM: 'Twilio voice-enabled caller ID (E.164)',
  FRONT_DESK_PHONE_NUMBER: 'Front desk destination phone number (E.164)',
  TWILIO_BRIDGE_NUMBER: 'Twilio bridge phone number provided to Vapi transferCall (E.164)',
  PUBLIC_SERVER_URL: 'Public base URL for this server (used by Twilio webhooks)'
};

const OPTIONAL_ENV_VARS = {
  TWILIO_STATUS_CALLBACK_URL: 'Optional status callback URL for Twilio outbound calls'
};

const getEnv = (key, label) => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing ${label}. Set ${key} in the environment.`);
  }
  return value;
};

const ensureConfig = (connectCall) => {
  const config = Object.entries({
    ...SMS_ENV_VARS,
    ...(connectCall ? VOICE_ENV_VARS : {})
  }).reduce((acc, [key, description]) => {
    acc[key] = getEnv(key, description);
    return acc;
  }, {});

  Object.entries(OPTIONAL_ENV_VARS).forEach(([key]) => {
    if (process.env[key]) {
      config[key] = process.env[key];
    }
  });

  if (connectCall) {
    try {
      const parsed = new URL(config.PUBLIC_SERVER_URL);
      if (parsed.protocol !== 'https:') {
        throw new Error('PUBLIC_SERVER_URL must use HTTPS.');
      }

      const hostname = parsed.hostname.toLowerCase();
      if (hostname === 'localhost' || hostname.endsWith('.local')) {
        throw new Error('PUBLIC_SERVER_URL must be publicly reachable for Twilio webhooks.');
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'Invalid PUBLIC_SERVER_URL. Provide a valid HTTPS base URL accessible by Twilio.';
      throw new Error(message);
    }
  }

  return config;
};

const normalizeList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => `${item}`.trim()).filter(Boolean);
  }
  const single = `${value}`.trim();
  return single ? [single] : [];
};

const buildStaffMessage = ({
  guestStatus,
  guestName,
  guestContact,
  summary,
  actionItems,
  mood,
  transferReason
}) => {
  const identifierParts = [guestStatus, guestName].map((part) => (part ? part.trim() : '')).filter(Boolean);
  const identifier = identifierParts.length > 0 ? identifierParts.join(' - ') : 'Guest';

  const lines = [`Broome Concierge | ${identifier}`];

  if (guestContact && guestContact.trim()) {
    lines.push(`Contact: ${guestContact.trim()}`);
  }

  if (summary && summary.trim()) {
    lines.push(`Request: ${summary.trim()}`);
  }

  const normalizedActions = normalizeList(actionItems);
  if (normalizedActions.length > 0) {
    lines.push(`Next steps: ${normalizedActions.join(' | ')}`);
  }

  if (transferReason && transferReason.trim()) {
    lines.push(`Transfer reason: ${transferReason.trim()}`);
  }

  if (mood && mood.trim()) {
    lines.push(`Mood: ${mood.trim()}`);
  }

  return lines.join('\n');
};

/**
 * Sends an SMS summary to the front desk and optionally dials them into a shared conference for live transfer.
 * @param {Object} params
 * @param {string} [params.callId] - Identifier from Vapi for the active call; defaults to a generated UUID.
 * @param {string} params.guestStatus - Guest classification such as "Prospect" or "In-house".
 * @param {string} [params.guestName] - Guest name if collected.
 * @param {string} [params.guestContact] - Guest phone number or room number.
 * @param {string} params.summary - Conversational summary for the handoff message.
 * @param {string[]|string} [params.actionItems] - Promised follow-ups or tasks.
 * @param {string} [params.mood] - Brief mood descriptor.
 * @param {string} [params.transferReason] - Reason the call is being transferred.
 * @param {boolean} [params.connectCall] - Whether to initiate a live bridge to the front desk.
 * @returns {Promise<{ conferenceName: string | null, bridgeNumber: string | null, messageSid: string, callSid: string | null }>}
 */
export const initiateWarmTransfer = async ({
  callId,
  guestStatus,
  guestName,
  guestContact,
  summary,
  actionItems,
  mood,
  transferReason,
  connectCall = false,
  guestCallSid
}) => {
  if (!guestStatus) {
    throw new Error('guestStatus is required (e.g., Prospect or In-house).');
  }

  if (!summary) {
    throw new Error('summary is required to brief the front desk.');
  }

  const config = ensureConfig(connectCall);
  const effectiveCallId = callId && callId.trim() ? callId.trim() : randomUUID();
  const client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);

  const message = await client.messages.create({
    from: config.TWILIO_SMS_FROM,
    to: config.FRONT_DESK_SMS_TO,
    body: buildStaffMessage({
      guestStatus,
      guestName,
      guestContact,
      summary,
      actionItems,
      mood,
      transferReason
    })
  });

  const baseResult = {
    conferenceName: null,
    bridgeNumber: null,
    messageSid: message.sid,
    callSid: null,
    guestConferenceUpdate: null
  };

  if (!connectCall) {
    return baseResult;
  }

  const conferenceName = `broome-${effectiveCallId}`;
  const voiceUrl = new URL('/twilio/voice/join-conference', config.PUBLIC_SERVER_URL);
  voiceUrl.searchParams.set('conference', conferenceName);

  const callPayload = {
    from: config.TWILIO_VOICE_FROM,
    to: config.FRONT_DESK_PHONE_NUMBER,
    url: voiceUrl.toString()
  };

  if (config.TWILIO_STATUS_CALLBACK_URL) {
    callPayload.statusCallback = config.TWILIO_STATUS_CALLBACK_URL;
    callPayload.statusCallbackEvent = ['initiated', 'ringing', 'answered', 'completed'];
  }

  const call = await client.calls.create(callPayload);

  registerBridgeConference(config.TWILIO_BRIDGE_NUMBER, conferenceName);

  let guestConferenceUpdate = null;

  if (guestCallSid && guestCallSid.trim()) {
    try {
      await client.calls(guestCallSid.trim()).update({
        method: 'POST',
        url: voiceUrl.toString()
      });
      guestConferenceUpdate = {
        callSid: guestCallSid.trim(),
        url: voiceUrl.toString()
      };
    } catch (error) {
      console.warn('Failed to move caller into bridge conference', {
        callSid: guestCallSid,
        error: error instanceof Error ? error.message : error
      });
    }
  } else {
    console.warn('Missing guestCallSid for live bridge conference');
  }

  return {
    conferenceName,
    bridgeNumber: config.TWILIO_BRIDGE_NUMBER,
    messageSid: message.sid,
    callSid: call.sid,
    guestConferenceUpdate
  };
};

export const placeFrontDeskTestCall = async () => {
  const config = ensureConfig(true);
  const client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);

  const conferenceName = `broome-test-${Date.now()}`;
  const voiceUrl = new URL('/twilio/voice/join-conference', config.PUBLIC_SERVER_URL);
  voiceUrl.searchParams.set('conference', conferenceName);

  const callPayload = {
    from: config.TWILIO_VOICE_FROM,
    to: config.FRONT_DESK_PHONE_NUMBER,
    url: voiceUrl.toString()
  };

  if (config.TWILIO_STATUS_CALLBACK_URL) {
    callPayload.statusCallback = config.TWILIO_STATUS_CALLBACK_URL;
    callPayload.statusCallbackEvent = ['initiated', 'ringing', 'answered', 'completed'];
  }

  const call = await client.calls.create(callPayload);

  return {
    callSid: call.sid,
    conferenceName,
    dialedNumber: config.FRONT_DESK_PHONE_NUMBER,
    voiceUrl: voiceUrl.toString()
  };
};

export default initiateWarmTransfer;
