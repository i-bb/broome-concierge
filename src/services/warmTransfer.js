import twilio from 'twilio';
import { randomUUID } from 'crypto';

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
  connectCall = false
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

  if (!connectCall) {
    return {
      conferenceName: null,
      bridgeNumber: null,
      messageSid: message.sid,
      callSid: null
    };
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

  return {
    conferenceName,
    bridgeNumber: config.TWILIO_BRIDGE_NUMBER,
    messageSid: message.sid,
    callSid: call.sid
  };
};

export default initiateWarmTransfer;
